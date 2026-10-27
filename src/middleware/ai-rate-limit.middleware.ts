import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../utils/http-error";
import { getSettings } from "../services/settings.service";
import { resolveAccess } from "../services/access.service";
import { recordAiUsage, type AiOperation } from "../services/ai/usage";
import { prisma } from "../db/client";
import { takeRateLimit } from "../utils/rate-limit";

// Per-user caps on AI calls, independent of the free-generation quota: they
// protect the AI provider's token budget (and our bill) from a single user
// or script hammering unmetered endpoints like polish-summary. The caps come
// from the "limits" platform setting (default 8/minute, 150/day); a user
// with the "aiRateLimit" exemption grant skips them. Counted in Postgres, so
// every server instance shares the same caps (see utils/rate-limit.ts).
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = "ai:";

// Drop calls older than the longest window so the table can't grow forever.
setInterval(() => {
  prisma.rateLimitHit
    .deleteMany({ where: { key: { startsWith: KEY_PREFIX }, createdAt: { lt: new Date(Date.now() - DAY_MS) } } })
    .catch((err) => console.error("[ai-rate-limit] prune failed", err));
}, 60 * 60 * 1000).unref();

export type AiCallResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "paused" };

/** Records one AI call for this user, or says why it may not happen now. */
export async function takeAiCall(userId: string, operation: AiOperation = "cv_generation"): Promise<AiCallResult> {
  const settings = await getSettings();
  if (settings.platform.aiGenerationPaused) {
    void recordAiUsage({ operation, userId, status: "paused", errorCode: "AI_PAUSED" });
    return { ok: false, reason: "paused" };
  }

  const access = await resolveAccess(userId);
  if (access?.exemptions.aiRateLimit) return { ok: true };

  // The caps are platform settings, so the windows are read per call.
  const result = await takeRateLimit(
    [KEY_PREFIX + userId],
    [
      { ms: MINUTE_MS, max: settings.limits.aiRequestsPerMinute },
      { ms: DAY_MS, max: settings.limits.aiRequestsPerDay },
    ]
  );
  if (!result.ok) {
    void recordAiUsage({ operation, userId, status: "app_rate_limited", errorCode: "RATE_LIMITED" });
    return { ok: false, reason: "rate_limited", retryAfterSeconds: result.retryAfterSeconds };
  }
  return { ok: true };
}

export function sendAiRateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  return sendError(
    reply,
    429,
    "RATE_LIMITED",
    `You're making AI requests too quickly. Try again in ${retryAfterSeconds} seconds.`
  );
}

export function sendAiPaused(reply: FastifyReply) {
  return sendError(
    reply,
    503,
    "AI_PAUSED",
    "AI generation is paused for maintenance. Please try again a little later."
  );
}

/** Replies for a refused AI call. */
export function sendAiRefusal(reply: FastifyReply, result: Exclude<AiCallResult, { ok: true }>) {
  return result.reason === "paused" ? sendAiPaused(reply) : sendAiRateLimited(reply, result.retryAfterSeconds);
}

/** preHandler for routes that always call the AI. Must run after requireAuth. */
export function aiRateLimitFor(operation: AiOperation) {
  return async function aiRateLimit(request: FastifyRequest, reply: FastifyReply) {
    const result = await takeAiCall(request.userId, operation);
    if (!result.ok) return sendAiRefusal(reply, result);
  };
}

export const aiRateLimit = aiRateLimitFor("cv_generation");
