import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { createRateLimiter, type RateResult } from "../utils/rate-limit";
import { resolveAccess } from "../services/access.service";
import {
  ANONYMOUS_CLIENT_EVENTS,
  clientEventSchema,
  parseClientEvent,
  recordEvent,
} from "../services/events.service";
import { feedbackSchema, FeedbackCvNotFoundError, recordFeedback } from "../services/feedback.service";

// The first-run experience after onboarding, and what people tell us:
//   GET  /api/v1/me/activation     — the getting-started checklist and one-time prompts
//   POST /api/v1/me/prompts/:key   — a prompt was shown / dismissed / completed
//   POST /api/v1/feedback          — a CV rating or thumbs on an AI draft
//   POST /api/v1/events            — an allow-listed UI event (signed in)
//   POST /api/v1/events/anonymous  — the same, before sign-up (/try pages only)

// cv_rating is the rating itself (completed = they rated). It's asked at two
// moments — leaving the editor after the first CV, and after a download —
// each at most once (cv_rating_exit / cv_rating_download record that it was
// asked there), and never again once they've rated.
export const PROMPT_KEYS = ["checklist", "tour_offer", "cv_rating", "cv_rating_exit", "cv_rating_download"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

const promptActionSchema = z.object({ action: z.enum(["shown", "dismissed", "completed"]) });

// Generous for a real person clicking around; stops a script from filling the table.
const userEventLimiter = createRateLimiter("events-user", [
  { ms: 60 * 1000, max: 60 },
  { ms: 24 * 60 * 60 * 1000, max: 2000 },
]);
const anonymousEventLimiter = createRateLimiter("events-anon", [
  { ms: 10 * 60 * 1000, max: 30 },
  { ms: 24 * 60 * 60 * 1000, max: 200 },
]);
const feedbackLimiter = createRateLimiter("feedback", [
  { ms: 60 * 1000, max: 10 },
  { ms: 24 * 60 * 60 * 1000, max: 100 },
]);

function sendRateLimited(reply: FastifyReply, limit: Extract<RateResult, { ok: false }>) {
  reply.header("Retry-After", String(limit.retryAfterSeconds));
  return sendError(reply, 429, "RATE_LIMITED", `Too many requests. Please wait ${limit.retryAfterSeconds} seconds.`);
}

export async function activationRoutes(app: FastifyInstance) {
  app.get("/api/v1/me/activation", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    const [cvCount, finalCvCount, tailoredCount, profileCount, downloadEvent, prompts, access] = await Promise.all([
      prisma.cVDocument.count({ where: { userId } }),
      prisma.cVDocument.count({ where: { userId, status: "final" } }),
      prisma.cVDocument.count({ where: { userId, jobDescription: { not: null } } }),
      prisma.careerProfile.count({ where: { userId } }),
      prisma.productEvent.findFirst({ where: { userId, name: "pdf_downloaded" }, select: { id: true } }),
      prisma.userPrompt.findMany({ where: { userId } }),
      resolveAccess(userId),
    ]);

    const promptState = Object.fromEntries(
      PROMPT_KEYS.map((key) => {
        const row = prompts.find((p) => p.key === key);
        return [key, row ? { shownAt: row.shownAt, dismissedAt: row.dismissedAt, completedAt: row.completedAt } : null];
      })
    );

    return reply.send({
      data: {
        steps: {
          firstCv: cvCount > 0,
          // A download finalizes the CV first, so a final CV means one was downloaded
          // (also for downloads from before downloads were tracked).
          pdfDownloaded: Boolean(downloadEvent) || finalCvCount > 0,
          careerProfile: profileCount > 0,
          tailoredCv: tailoredCount > 0,
        },
        // Career profiles are Pro: the checklist's last step is a tailored CV for everyone else.
        canUseCareerProfiles: Boolean(access?.features.careerProfiles),
        prompts: promptState,
      },
      error: null,
    });
  });

  app.post("/api/v1/me/prompts/:key", { preHandler: requireAuth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) {
      return sendError(reply, 404, "UNKNOWN_PROMPT", "Unknown prompt");
    }
    const parsed = promptActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const now = new Date();
    const field = { shown: "shownAt", dismissed: "dismissedAt", completed: "completedAt" }[parsed.data.action] as
      | "shownAt"
      | "dismissedAt"
      | "completedAt";
    // The first time of each counts: showing it again doesn't move shownAt.
    const existing = await prisma.userPrompt.findUnique({ where: { userId_key: { userId: request.userId, key } } });
    const row = existing
      ? existing[field]
        ? existing
        : await prisma.userPrompt.update({ where: { id: existing.id }, data: { [field]: now } })
      : await prisma.userPrompt
          .create({ data: { userId: request.userId, key, [field]: now } })
          // Two tabs at once: the other one created it.
          .catch(() => prisma.userPrompt.findUniqueOrThrow({ where: { userId_key: { userId: request.userId, key } } }));

    return reply.send({
      data: { key, shownAt: row.shownAt, dismissedAt: row.dismissedAt, completedAt: row.completedAt },
      error: null,
    });
  });

  app.post("/api/v1/feedback", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    const limit = await feedbackLimiter.take([`user:${request.userId}`]);
    if (!limit.ok) return sendRateLimited(reply, limit);

    try {
      const feedback = await recordFeedback(request.userId, parsed.data);
      return reply.code(201).send({ data: { id: feedback.id }, error: null });
    } catch (err) {
      if (err instanceof FeedbackCvNotFoundError) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", err.message);
      throw err;
    }
  });

  app.post("/api/v1/events", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = clientEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    const event = parseClientEvent(parsed.data.name, parsed.data.props);
    if (!event.ok) return sendError(reply, 400, "INVALID_EVENT", event.message);

    const limit = await userEventLimiter.take([`user:${request.userId}`]);
    if (!limit.ok) return sendRateLimited(reply, limit);

    await recordEvent({
      name: event.name,
      props: event.props,
      userId: request.userId,
      anonymousId: parsed.data.anonymousId ?? null,
      source: "client",
    });
    return reply.code(202).send({ data: { recorded: true }, error: null });
  });

  app.post("/api/v1/events/anonymous", async (request, reply) => {
    const parsed = clientEventSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.anonymousId) {
      return sendError(reply, 400, "VALIDATION_ERROR", "An event name and anonymousId are required");
    }
    const event = parseClientEvent(parsed.data.name, parsed.data.props);
    if (!event.ok) return sendError(reply, 400, "INVALID_EVENT", event.message);
    if (!ANONYMOUS_CLIENT_EVENTS.includes(event.name)) {
      return sendError(reply, 401, "UNAUTHORIZED", "Sign in to send this event");
    }

    const limit = await anonymousEventLimiter.take([`ip:${request.ip}`]);
    if (!limit.ok) return sendRateLimited(reply, limit);

    await recordEvent({ name: event.name, props: event.props, anonymousId: parsed.data.anonymousId, source: "client" });
    return reply.code(202).send({ data: { recorded: true }, error: null });
  });
}
