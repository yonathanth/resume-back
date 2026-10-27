import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { listUserNotifications, verifyUnsubscribe } from "../services/notification.service";
import { isPushConfigured, pushPublicKey } from "../services/push.service";
import { getSettings } from "../services/settings.service";

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000).refine((v) => v.startsWith("https://"), "Push endpoints must be https"),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

const preferencesSchema = z.object({
  emailAnnouncements: z.boolean(),
});

const unsubscribeSchema = z.object({
  u: z.string().uuid(),
  t: z.string().min(1).max(100),
});

export async function notificationRoutes(app: FastifyInstance) {
  // Public: what the app shell needs before (and after) sign-in — the
  // maintenance banner and whether sign-up is open. Nothing else from
  // settings is exposed.
  app.get("/api/v1/platform/status", async (_request, reply) => {
    const { platform } = await getSettings();
    return reply.send({
      data: {
        registrationEnabled: platform.registrationEnabled,
        aiGenerationPaused: platform.aiGenerationPaused,
        banner: platform.banner.enabled && platform.banner.message ? { message: platform.banner.message, tone: platform.banner.tone } : null,
      },
      error: null,
    });
  });

  app.get("/api/v1/notifications", { preHandler: requireAuth }, async (request, reply) => {
    return reply.send({ data: await listUserNotifications(request.userId), error: null });
  });

  // Scoped by userId in the WHERE clause, so a user can't touch someone else's row.
  app.post("/api/v1/notifications/:id/read", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { count } = await prisma.userNotification.updateMany({
      where: { id, userId: request.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send({ data: { updated: count }, error: null });
  });

  app.post("/api/v1/notifications/read-all", { preHandler: requireAuth }, async (request, reply) => {
    const { count } = await prisma.userNotification.updateMany({
      where: { userId: request.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send({ data: { updated: count }, error: null });
  });

  app.post("/api/v1/notifications/:id/dismiss", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const now = new Date();
    const { count } = await prisma.userNotification.updateMany({
      where: { id, userId: request.userId, dismissedAt: null },
      data: { dismissedAt: now },
    });
    await prisma.userNotification.updateMany({ where: { id, userId: request.userId, readAt: null }, data: { readAt: now } });
    return reply.send({ data: { updated: count }, error: null });
  });

  app.get("/api/v1/notifications/preferences", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { emailAnnouncementsOptOut: true, _count: { select: { pushSubscriptions: true } } },
    });
    if (!user) return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    return reply.send({
      data: {
        emailAnnouncements: !user.emailAnnouncementsOptOut,
        push: { available: isPushConfigured(), publicKey: pushPublicKey(), subscribedDevices: user._count.pushSubscriptions },
      },
      error: null,
    });
  });

  app.patch("/api/v1/notifications/preferences", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    await prisma.user.update({
      where: { id: request.userId },
      data: { emailAnnouncementsOptOut: !parsed.data.emailAnnouncements },
    });
    return reply.send({ data: { emailAnnouncements: parsed.data.emailAnnouncements }, error: null });
  });

  // The link in announcement emails — works without signing in; the HMAC in
  // `t` proves the link was issued for this user.
  app.post("/api/v1/notifications/unsubscribe", async (request, reply) => {
    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success || !verifyUnsubscribe(parsed.data.u, parsed.data.t)) {
      return sendError(reply, 400, "INVALID_UNSUBSCRIBE_LINK", "This unsubscribe link is invalid.");
    }
    await prisma.user.updateMany({ where: { id: parsed.data.u }, data: { emailAnnouncementsOptOut: true } });
    return reply.send({ data: { unsubscribed: true }, error: null });
  });

  app.post("/api/v1/notifications/push/subscribe", { preHandler: requireAuth }, async (request, reply) => {
    if (!isPushConfigured()) {
      return sendError(reply, 503, "PUSH_NOT_CONFIGURED", "Browser notifications aren't available right now.");
    }
    const parsed = pushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid subscription");
    }
    const { endpoint, keys } = parsed.data;
    const userAgent = (request.headers["user-agent"] as string | undefined)?.slice(0, 300) ?? null;
    // An endpoint belongs to one browser; re-subscribing (or another account
    // signing in on the same browser) moves it to the current user.
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: request.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
      update: { userId: request.userId, p256dh: keys.p256dh, auth: keys.auth, userAgent, failureCount: 0 },
    });
    return reply.send({ data: { subscribed: true }, error: null });
  });

  app.post("/api/v1/notifications/push/unsubscribe", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ endpoint: z.string().max(1000) }).safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", "endpoint is required");
    }
    await prisma.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint, userId: request.userId } });
    return reply.send({ data: { subscribed: false }, error: null });
  });
}
