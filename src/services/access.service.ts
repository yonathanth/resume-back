import type { Entitlement, User } from "@prisma/client";
import { prisma } from "../db/client";
import {
  FEATURE_KEYS,
  FLOW_TYPES,
  getSettings,
  type FeatureKey,
  type FlowCounts,
  type FlowKey,
  type Settings,
} from "./settings.service";
import { findSubscriptionByProductId, type BillingPeriod, type PlanTier } from "./polar/plans";

// The one place that decides what a user may do. Every backend gate
// (generation limits, paid-only features, AI rate-limit exemptions) and the
// /subscriptions/status response the frontend renders from read this, so
// the UI and the API can't disagree.
//
// The plan (tier), highest first:
//   1. Pro  — an active Pro subscription, or an active PRO_ACCESS grant.
//   2. Plus — an active Plus subscription (also the retired single-plan
//      products, Chapa periods and unknown paid products), an active
//      PLUS_ACCESS grant, or a LIFETIME_PLUS grant (Plus Lifetime).
//   3. Free — everyone else.
// Grants never touch billing fields, so when a grant ends the user falls back
// to exactly what billing says.
//
// Generations:
//   Free — a shared pool of free AI CVs (plans.free.generations + every active
//          LIMIT_ADJUSTMENT grant, any flow), counted on freeXUses. Past it,
//          CVs can still be made but must be paid for at download.
//   Plus — per-flow limits per billing period (Lifetime: per month).
//   Pro  — unmetered in the UI; a hidden fair-use cap per period.
//   The "generationQuota" exemption makes every flow unmetered.
// Feature rules: "pro" means any paid plan (Plus or Pro); "off" is off for
// everyone; "beta" is the beta program.
// A grant is active when it isn't revoked, has started and hasn't expired —
// checked against "now" on every request, so expiry needs no background job.

export const ENTITLEMENT_KINDS = ["PRO_ACCESS", "PLUS_ACCESS", "LIFETIME_PLUS", "FEATURE", "LIMIT_ADJUSTMENT", "EXEMPTION"] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export const EXEMPTION_KEYS = ["aiRateLimit", "generationQuota"] as const;
export type ExemptionKey = (typeof EXEMPTION_KEYS)[number];

/** Feature grants: a gated feature, or the beta program. */
export const GRANTABLE_FEATURES = [...FEATURE_KEYS, "beta"] as const;

const ACTIVE_SUBSCRIPTION_STATUS = "active";

export type AccessUser = Pick<
  User,
  | "subscriptionStatus"
  | "subscriptionCurrentPeriodEnd"
  | "subscriptionProvider"
  | "polarProductId"
  | "freeCreateUses"
  | "freeTailorUses"
  | "freeImproveUses"
  | "usagePeriodKey"
  | "periodCreateUses"
  | "periodTailorUses"
  | "periodImproveUses"
>;

export type AccessGrant = Pick<
  Entitlement,
  "id" | "kind" | "feature" | "flow" | "amount" | "startsAt" | "expiresAt" | "revokedAt"
>;

export interface FlowLimit {
  /** null = unmetered. */
  limit: number | null;
  used: number;
  /** null = unmetered. */
  remaining: number | null;
  /** Pro's fair-use cap: enforced, never shown to the user. */
  hidden?: boolean;
}

export type PlanPeriod = BillingPeriod | "lifetime";

export interface PlanInfo {
  tier: PlanTier;
  /** The billing period the limits are counted over (grants count monthly). */
  period: PlanPeriod | null;
  source: "subscription" | "grant" | "lifetime" | null;
  /** On a retired single-plan product (now Plus). */
  legacy: boolean;
  /** Names the current usage period; usage stored under another key is stale. */
  periodKey: string | null;
  /** When the current usage period ends (limits reset). */
  periodEndsAt: Date | null;
}

export interface AccessSnapshot {
  tier: PlanTier;
  /** Plus or Pro. */
  isPaid: boolean;
  /** Pro only (not Plus). */
  isPro: boolean;
  plan: PlanInfo;
  /** Owns Plus Lifetime (whatever the current tier). */
  hasLifetime: boolean;
  /** What gives the paid plan: the paid subscription wins when both apply. */
  proSource: "subscription" | "grant" | null;
  billingPro: boolean;
  /** Latest end of the active paid-access grants; null when one has no end (or there is none). */
  proGrantExpiresAt: Date | null;
  beta: boolean;
  features: Record<FeatureKey, boolean>;
  exemptions: Record<ExemptionKey, boolean>;
  /** The free pool (any flow). */
  free: FlowLimit;
  /** What each flow may still do on the current plan. On Free, each is the shared pool. */
  limits: Record<FlowKey, FlowLimit>;
  activeGrantIds: string[];
}

export function isGrantActive(grant: Pick<AccessGrant, "startsAt" | "expiresAt" | "revokedAt">, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.startsAt.getTime() > now.getTime()) return false;
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/** An active, unexpired paid subscription (Polar or Chapa), whatever its tier. */
export function hasBillingPro(
  user: Pick<User, "subscriptionStatus" | "subscriptionCurrentPeriodEnd">,
  now: Date = new Date()
): boolean {
  if (user.subscriptionStatus !== ACTIVE_SUBSCRIPTION_STATUS) return false;
  if (user.subscriptionCurrentPeriodEnd && user.subscriptionCurrentPeriodEnd.getTime() < now.getTime()) return false;
  return true;
}

export const FREE_USES_FIELD: Record<FlowKey, "freeCreateUses" | "freeTailorUses" | "freeImproveUses"> = {
  create: "freeCreateUses",
  tailor: "freeTailorUses",
  improve: "freeImproveUses",
};

export const PERIOD_USES_FIELD: Record<FlowKey, "periodCreateUses" | "periodTailorUses" | "periodImproveUses"> = {
  create: "periodCreateUses",
  tailor: "periodTailorUses",
  improve: "periodImproveUses",
};

/** `months` calendar months after `date` (UTC), clamped to the month's last day. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** The monthly window anchored at `start` that `now` falls in: its index and end. */
export function monthlyWindow(start: Date, now: Date): { index: number; endsAt: Date } {
  let index = Math.max(0, (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth());
  while (index > 0 && addMonths(start, index).getTime() > now.getTime()) index--;
  while (addMonths(start, index + 1).getTime() <= now.getTime()) index++;
  return { index, endsAt: addMonths(start, index + 1) };
}

const earliest = (grants: AccessGrant[]) => [...grants].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];

function resolvePlan(user: AccessUser, grants: AccessGrant[], now: Date): PlanInfo & { billingPro: boolean } {
  const billingPro = hasBillingPro(user, now);
  const subscription = billingPro
    ? findSubscriptionByProductId(user.polarProductId) ?? { tier: "plus" as const, period: "monthly" as const, legacy: false }
    : null;
  const proGrant = earliest(grants.filter((g) => g.kind === "PRO_ACCESS"));
  const plusGrant = earliest(grants.filter((g) => g.kind === "PLUS_ACCESS"));
  const lifetime = earliest(grants.filter((g) => g.kind === "LIFETIME_PLUS"));

  const fromSubscription = (): PlanInfo => {
    const end = user.subscriptionCurrentPeriodEnd;
    // A period without an end date (shouldn't happen) counts by calendar month.
    const key = end ? `sub:${end.toISOString()}` : `sub:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
    return {
      tier: subscription!.tier,
      period: subscription!.period,
      source: "subscription",
      legacy: subscription!.legacy,
      periodKey: key,
      periodEndsAt: end ?? null,
    };
  };
  const fromGrant = (grant: AccessGrant, tier: PlanTier, source: "grant" | "lifetime"): PlanInfo => {
    const window = monthlyWindow(grant.startsAt, now);
    return {
      tier,
      period: source === "lifetime" ? "lifetime" : "monthly",
      source,
      legacy: false,
      periodKey: `${source}:${grant.id}:${window.index}`,
      periodEndsAt: window.endsAt,
    };
  };

  let plan: PlanInfo;
  if (subscription?.tier === "pro") plan = fromSubscription();
  else if (proGrant) plan = fromGrant(proGrant, "pro", "grant");
  else if (subscription) plan = fromSubscription();
  else if (plusGrant) plan = fromGrant(plusGrant, "plus", "grant");
  else if (lifetime) plan = fromGrant(lifetime, "plus", "lifetime");
  else plan = { tier: "free", period: null, source: null, legacy: false, periodKey: null, periodEndsAt: null };
  return { ...plan, billingPro };
}

function periodCounts(settings: Pick<Settings, "plans">, plan: PlanInfo): FlowCounts | null {
  if (plan.tier === "plus") return settings.plans.plus[plan.period ?? "monthly"];
  if (plan.tier === "pro") return settings.plans.proFairUse[plan.period === "lifetime" || !plan.period ? "monthly" : plan.period];
  return null;
}

export function computeAccess(
  user: AccessUser,
  grants: AccessGrant[],
  settings: Pick<Settings, "plans" | "features">,
  now: Date = new Date()
): AccessSnapshot {
  const active = grants.filter((g) => isGrantActive(g, now));
  const featureGrants = new Set(active.filter((g) => g.kind === "FEATURE" && g.feature).map((g) => g.feature!));
  const exemptionGrants = new Set(active.filter((g) => g.kind === "EXEMPTION" && g.feature).map((g) => g.feature!));

  const { billingPro, ...plan } = resolvePlan(user, active, now);
  const isPaid = plan.tier !== "free";
  const beta = featureGrants.has("beta");

  const accessGrants = active.filter((g) => g.kind === "PRO_ACCESS" || g.kind === "PLUS_ACCESS");
  let proGrantExpiresAt: Date | null = null;
  if (accessGrants.length > 0 && accessGrants.every((g) => g.expiresAt)) {
    proGrantExpiresAt = new Date(Math.max(...accessGrants.map((g) => g.expiresAt!.getTime())));
  }

  const features = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    const rule = settings.features[key];
    features[key] =
      rule === "off"
        ? false
        : rule === "all"
          ? true
          : rule === "pro"
            ? isPaid || featureGrants.has(key)
            : beta || featureGrants.has(key);
  }

  const exemptions: Record<ExemptionKey, boolean> = {
    aiRateLimit: exemptionGrants.has("aiRateLimit"),
    generationQuota: exemptionGrants.has("generationQuota"),
  };

  const freeUsed = user.freeCreateUses + user.freeTailorUses + user.freeImproveUses;
  const adjustment = active.filter((g) => g.kind === "LIMIT_ADJUSTMENT").reduce((sum, g) => sum + (g.amount ?? 0), 0);
  const freeLimit = Math.max(0, settings.plans.free.generations + adjustment);
  const free: FlowLimit = { limit: freeLimit, used: freeUsed, remaining: Math.max(0, freeLimit - freeUsed) };

  const counts = periodCounts(settings, plan);
  const samePeriod = plan.periodKey !== null && user.usagePeriodKey === plan.periodKey;
  const limits = {} as Record<FlowKey, FlowLimit>;
  for (const flow of FLOW_TYPES) {
    const used = counts ? (samePeriod ? user[PERIOD_USES_FIELD[flow]] : 0) : freeUsed;
    if (exemptions.generationQuota) {
      limits[flow] = { limit: null, used, remaining: null };
    } else if (counts) {
      const limit = counts[flow];
      limits[flow] = { limit, used, remaining: Math.max(0, limit - used), ...(plan.tier === "pro" ? { hidden: true } : {}) };
    } else {
      limits[flow] = { ...free };
    }
  }

  return {
    tier: plan.tier,
    isPaid,
    isPro: plan.tier === "pro",
    plan,
    hasLifetime: active.some((g) => g.kind === "LIFETIME_PLUS"),
    proSource: !isPaid ? null : plan.source === "subscription" ? "subscription" : "grant",
    billingPro,
    proGrantExpiresAt,
    beta,
    features,
    exemptions,
    free,
    limits,
    activeGrantIds: active.map((g) => g.id),
  };
}

/** Grants that could be active now (not revoked, not expired) — the rest can't affect access. */
export function liveGrantsWhere(userId: string, now: Date = new Date()) {
  return {
    userId,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export const ACCESS_USER_SELECT = {
  subscriptionStatus: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionProvider: true,
  polarProductId: true,
  freeCreateUses: true,
  freeTailorUses: true,
  freeImproveUses: true,
  usagePeriodKey: true,
  periodCreateUses: true,
  periodTailorUses: true,
  periodImproveUses: true,
} as const;

export async function resolveAccess(userId: string): Promise<AccessSnapshot | null> {
  const now = new Date();
  const [user, grants, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: ACCESS_USER_SELECT }),
    prisma.entitlement.findMany({ where: liveGrantsWhere(userId, now) }),
    getSettings(),
  ]);
  if (!user) return null;
  return computeAccess(user, grants, settings, now);
}

const PRO_FEATURE_MESSAGES: Record<FeatureKey, string> = {
  careerProfiles: "Career Profiles come with GoMoxie Plus and Pro. Upgrade to use them",
  polishSummary: "AI summary polish comes with GoMoxie Plus and Pro. Upgrade to use it",
  cvImport: "CV upload comes with GoMoxie Plus and Pro. Upgrade to use it",
  aiPolish: "AI polish comes with GoMoxie Plus and Pro. Upgrade to use it",
};

/** A paid-only feature for a user on Free (→ 402 PRO_REQUIRED, which the frontend's paywall handles). */
export class ProFeatureRequiredError extends Error {
  constructor(feature: FeatureKey) {
    super(PRO_FEATURE_MESSAGES[feature]);
    this.name = "ProFeatureRequiredError";
  }
}

/** A feature switched off, or limited to the beta program (→ 403 FEATURE_UNAVAILABLE). */
export class FeatureUnavailableError extends Error {
  constructor(public reason: "off" | "beta") {
    super(reason === "off" ? "This feature is turned off right now." : "This feature is only available to beta testers right now.");
    this.name = "FeatureUnavailableError";
  }
}

/** The backend gate for a feature. Throws when the user may not use it. */
export async function assertFeatureAccess(userId: string, feature: FeatureKey): Promise<void> {
  const [access, settings] = await Promise.all([resolveAccess(userId), getSettings()]);
  if (access?.features[feature]) return;
  const rule = settings.features[feature];
  if (rule === "pro") throw new ProFeatureRequiredError(feature);
  throw new FeatureUnavailableError(rule === "off" ? "off" : "beta");
}
