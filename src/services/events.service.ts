import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

// Product analytics (the ProductEvent table): milestones on the way to a
// finished CV, for the admin's activation funnel. Recording is best effort —
// it never throws and never slows the request it's called from down by
// failing. Props must never carry CV content or other personal details.

/** Milestones the server records where they happen. */
export type ServerEventName =
  | "signup_started" // password sign-up submitted (email not confirmed yet)
  | "account_created" // first usable session: email confirmed, or first Google sign-in
  | "onboarding_completed"
  | "onboarding_from_cv" // a /try sign-up's details filled in from the CV they made
  | "cv_generated"
  | "pdf_downloaded"
  | "career_profile_created"
  | "user_active"; // at most once per user per UTC day

export interface TrackInput {
  name: string;
  userId?: string | null;
  anonymousId?: string | null;
  props?: Record<string, unknown> | null;
  source?: "server" | "client";
  /** Events that count once: a second insert with the same key is skipped. */
  dedupeKey?: string | null;
}

export async function recordEvent(input: TrackInput): Promise<void> {
  try {
    await prisma.productEvent.createMany({
      data: [
        {
          name: input.name,
          userId: input.userId ?? null,
          anonymousId: input.anonymousId ?? null,
          props: (input.props ?? undefined) as Prisma.InputJsonValue | undefined,
          source: input.source ?? "server",
          dedupeKey: input.dedupeKey ?? null,
        },
      ],
      skipDuplicates: true,
    });
  } catch (err) {
    console.warn("[events] failed to record", input.name, err instanceof Error ? err.message : err);
  }
}

/** A server milestone, fire-and-forget. */
export function trackEvent(name: ServerEventName, userId: string, props?: Record<string, unknown>, dedupeKey?: string) {
  void recordEvent({ name, userId, props, dedupeKey });
}

/** "2026-10-16" — the UTC day an activity falls on. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** The user used the app today (sign-in or session refresh). One row per user per day. */
export function trackActiveDay(userId: string, now: Date = new Date()) {
  trackEvent("user_active", userId, undefined, `active:${userId}:${utcDay(now)}`);
}

// ---- Events from the browser (POST /api/v1/events) ----

const flow = z.enum(["create", "tailor", "improve"]);
const shortText = z.string().trim().max(60);

// Each allowed event and the props it may carry. Anything not listed is
// refused, so the endpoint can't be used to store arbitrary data.
export const CLIENT_EVENT_SCHEMAS = {
  // Signed out on a /try page.
  try_started: z.object({ flow }).strict(),
  try_signup_prompted: z.object({ flow }).strict(),
  // Onboarding.
  onboarding_step_viewed: z.object({ step: shortText }).strict(),
  onboarding_skipped: z.object({ step: shortText }).strict(),
  // After onboarding.
  checklist_item_clicked: z.object({ item: shortText }).strict(),
  tour_started: z.object({ from: shortText }).strict(),
  tour_finished: z.object({ steps: z.number().int().min(0).max(50) }).strict(),
} as const;

export type ClientEventName = keyof typeof CLIENT_EVENT_SCHEMAS;

/** Events a signed-out visitor may send (everything else needs an account). */
export const ANONYMOUS_CLIENT_EVENTS: readonly ClientEventName[] = ["try_started", "try_signup_prompted"];

export const clientEventSchema = z.object({
  name: z.string().min(1).max(60),
  props: z.record(z.string(), z.unknown()).optional(),
  // A random id the browser keeps (uuid), to connect events from before sign-up.
  anonymousId: z.string().uuid().optional(),
});

export type ParsedClientEvent =
  | { ok: true; name: ClientEventName; props: Record<string, unknown> }
  | { ok: false; message: string };

export function parseClientEvent(name: string, props: unknown): ParsedClientEvent {
  // Own keys only: `in` would also match inherited names like "__proto__".
  if (!Object.hasOwn(CLIENT_EVENT_SCHEMAS, name)) return { ok: false, message: `Unknown event "${name}"` };
  const eventName = name as ClientEventName;
  const parsed = CLIENT_EVENT_SCHEMAS[eventName].safeParse(props ?? {});
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid event props" };
  return { ok: true, name: eventName, props: parsed.data as Record<string, unknown> };
}
