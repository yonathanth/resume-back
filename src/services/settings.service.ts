import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

// Admin-editable platform settings. Every key has a schema and a default
// equal to how the app behaved before settings existed, so a missing or
// unreadable row never changes anyone's access. Values are cached briefly;
// a write through updateSetting clears the cache on this instance (other
// instances pick it up within CACHE_TTL_MS).

export const FLOW_TYPES = ["create", "tailor", "improve"] as const;
export type FlowKey = (typeof FLOW_TYPES)[number];

// all  — every signed-in user
// pro  — any paid plan (Plus or Pro, paid or granted), or a user granted this feature
// beta — users in the beta program, or granted this feature
// off  — nobody (admins are not exempt; it's a kill switch)
export const FEATURE_ACCESS_LEVELS = ["all", "pro", "beta", "off"] as const;
export type FeatureAccessLevel = (typeof FEATURE_ACCESS_LEVELS)[number];

/** The features that actually exist in GoMoxie and are gated on the backend. */
/** The features that actually exist in GoMoxie and are gated on the backend. */
export const FEATURE_KEYS = ["careerProfiles", "polishSummary", "cvImport", "aiPolish"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_INFO: Record<FeatureKey, { label: string; description: string; endpoints: string[] }> = {
  careerProfiles: {
    label: "Career profiles",
    description:
      "Creating, editing and linking career profiles, and generating CVs from them. Reading and deleting existing profiles is always allowed so nobody loses access to their own data.",
    endpoints: ["POST/PATCH /profiles", "POST /profiles/from-cv", "wording + suggest", "PATCH /cv/:id/profile"],
  },
  polishSummary: {
    label: "AI summary polish",
    description: "The editor's \"AI Polish\" action on the professional summary.",
    endpoints: ["POST /cv/polish-summary"],
  },
  cvImport: {
    label: "CV upload import",
    description: "Uploading an existing CV (PDF, DOCX, image) to extract its text.",
    endpoints: ["POST /imports"],
  },
  aiPolish: {
    label: "AI polish (CV score)",
    description: "The CV score panel's \"Polish\" and \"Polish all\" actions that rewrite the summary, bullets, skills and headline.",
    endpoints: ["POST /cv/:id/polish"],
  },
};

const limitsSchema = z.object({
  // Per-user caps on AI calls (protects the provider budget), for everyone.
  aiRequestsPerMinute: z.number().int().min(1).max(1000),
  aiRequestsPerDay: z.number().int().min(1).max(100000),
});

const featuresSchema = z.object({
  careerProfiles: z.enum(FEATURE_ACCESS_LEVELS),
  polishSummary: z.enum(FEATURE_ACCESS_LEVELS),
  cvImport: z.enum(FEATURE_ACCESS_LEVELS),
  // Added after the others: stored rows from before it existed get the default instead of failing validation.
  aiPolish: z.enum(FEATURE_ACCESS_LEVELS).default("pro"),
});

const platformSchema = z.object({
  // Off: new email sign-ups and first-time Google sign-ins are refused. Existing accounts still sign in.
  registrationEnabled: z.boolean(),
  // On: every AI generation endpoint answers 503 (nothing is charged).
  aiGenerationPaused: z.boolean(),
  banner: z.object({
    enabled: z.boolean(),
    message: z.string().trim().max(300),
    tone: z.enum(["info", "warning"]),
  }),
});

const aiPricingSchema = z.object({
  // Prices the admin copies from the provider's pricing page. Used only to
  // show an *estimate*; never presented as the provider's bill.
  models: z
    .array(
      z.object({
        model: z.string().trim().min(1).max(120),
        inputPerMillionUsd: z.number().min(0).max(1000),
        outputPerMillionUsd: z.number().min(0).max(1000),
      })
    )
    .max(50),
});

const flowCount = z.number().int().min(0).max(100000);
const flowCountsSchema = z.object({ create: flowCount, tailor: flowCount, improve: flowCount });
export type FlowCounts = z.infer<typeof flowCountsSchema>;

// The plans' numbers (prices live in Polar — see services/polar/plans.ts).
const plansSchema = z.object({
  free: z.object({
    // Free AI CVs of any kind (new, tailored, improved), downloadable for free.
    generations: z.number().int().min(0).max(1000),
    // After that, AI CVs are made for free but locked until paid for at
    // download — at most this many unpaid ones at a time (protects AI cost).
    unpaidCvCap: z.number().int().min(0).max(100),
  }),
  // Per billing period. Lifetime limits reset every month.
  plus: z.object({ weekly: flowCountsSchema, monthly: flowCountsSchema, quarterly: flowCountsSchema, lifetime: flowCountsSchema }),
  // Pro is sold as unlimited; this fair-use cap per period is never shown in
  // the app (only the Terms mention it) and stops abuse.
  proFairUse: z.object({ weekly: flowCountsSchema, monthly: flowCountsSchema, quarterly: flowCountsSchema }),
  // The Plus Lifetime deal: both limits apply when set; `display` picks which
  // one the pricing cards show ("Limited seats available", or a countdown).
  lifetimeOffer: z.object({
    enabled: z.boolean(),
    display: z.enum(["seats", "countdown"]),
    seatLimit: z.number().int().min(0).max(1000000).nullable(),
    endsAt: z.string().datetime().nullable(),
  }),
});

const notificationsSchema = z.object({
  // Safety cap on one announcement's email fan-out (provider sending limits).
  maxEmailRecipients: z.number().int().min(1).max(50000),
});

const lifecycleEmailsSchema = z.object({
  // On: new accounts get the welcome email, a nudge if they haven't made a CV
  // after a day, and a reminder if they made one but never downloaded it
  // (see services/lifecycle.service.ts). Off by default: an admin turns it on.
  enabled: z.boolean(),
});

export const SETTING_SCHEMAS = {
  limits: limitsSchema,
  plans: plansSchema,
  features: featuresSchema,
  platform: platformSchema,
  aiPricing: aiPricingSchema,
  notifications: notificationsSchema,
  lifecycleEmails: lifecycleEmailsSchema,
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const DEFAULT_SETTINGS: Settings = {
  limits: { aiRequestsPerMinute: 8, aiRequestsPerDay: 150 },
  plans: {
    free: { generations: 1, unpaidCvCap: 3 },
    plus: {
      weekly: { create: 3, tailor: 10, improve: 6 },
      monthly: { create: 8, tailor: 30, improve: 20 },
      quarterly: { create: 25, tailor: 100, improve: 65 },
      lifetime: { create: 5, tailor: 20, improve: 12 },
    },
    proFairUse: {
      weekly: { create: 30, tailor: 80, improve: 80 },
      monthly: { create: 100, tailor: 300, improve: 300 },
      quarterly: { create: 250, tailor: 750, improve: 750 },
    },
    lifetimeOffer: { enabled: true, display: "seats", seatLimit: 200, endsAt: null },
  },
  features: { careerProfiles: "pro", polishSummary: "all", cvImport: "all", aiPolish: "pro" },
  platform: { registrationEnabled: true, aiGenerationPaused: false, banner: { enabled: false, message: "", tone: "info" } },
  aiPricing: { models: [] },
  notifications: { maxEmailRecipients: 500 },
  lifecycleEmails: { enabled: false },
};

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_SCHEMAS;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const rows = await prisma.platformSetting.findMany();
  const value: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    // A stored value that no longer validates (e.g. after a schema change)
    // falls back to the default for that key rather than breaking access.
    const parsed = SETTING_SCHEMAS[row.key].safeParse(row.value);
    if (parsed.success) (value as Record<SettingKey, unknown>)[row.key] = parsed.data;
  }
  cache = { at: Date.now(), value };
  return value;
}

export function clearSettingsCache() {
  cache = null;
}

export class SettingValidationError extends Error {}

/** Validates and stores one setting. Returns the previous and new value for the audit log. */
export async function updateSetting<K extends SettingKey>(key: K, input: unknown, actorId: string) {
  const parsed = SETTING_SCHEMAS[key].safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettingValidationError(`${issue?.path.join(".") || key}: ${issue?.message ?? "Invalid value"}`);
  }
  const before = (await getSettings())[key];
  const value = parsed.data as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value, updatedById: actorId },
    update: { value, updatedById: actorId },
  });
  clearSettingsCache();
  return { before, after: parsed.data as Settings[K] };
}
