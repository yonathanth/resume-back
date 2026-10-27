import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import { audienceSchema, countAudience, createNotification, createNotificationSchema } from "../../services/notification.service";
import { sendEmail } from "../../services/email/send";
import { testEmail } from "../../services/email/templates";
import { emailConfigStatus } from "../../services/email";
import { isPushConfigured } from "../../services/push.service";
import {
  announcementLimiter,
  audit,
  paged,
  pageArgs,
  paginationSchema,
  parseOr400,
  sendRateLimited,
  testEmailLimiter,
  uuidParam,
} from "./helpers";

const emailLogQuery = paginationSchema.extend({
  status: z.enum(["sent", "failed", "skipped"]).optional(),
  kind: z.enum(["verification", "email_change", "password_reset", "announcement", "subscription", "lifecycle", "test"]).optional(),
  q: z.string().trim().max(200).optional(),
});

export async function adminNotificationRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/notifications/channels", { preHandler: requirePermission("notifications:send") }, async (_request, reply) => {
    const pushSubscribers = await prisma.pushSubscription.groupBy({ by: ["userId"] }).then((rows) => rows.length);
    return reply.send({
      data: {
        in_app: { available: true },
        email: emailConfigStatus(),
        push: { available: isPushConfigured(), subscribedUsers: pushSubscribers },
      },
      error: null,
    });
  });

  app.post("/api/v1/admin/notifications/audience", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const body = parseOr400(z.object({ audience: audienceSchema }), request.body, reply);
    if (!body) return;
    return reply.send({ data: await countAudience(body.audience), error: null });
  });

  app.get("/api/v1/admin/notifications", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const query = parseOr400(paginationSchema, request.query, reply);
    if (!query) return;
    const [total, items] = await Promise.all([
      prisma.notification.count(),
      prisma.notification.findMany({ orderBy: { createdAt: "desc" }, ...pageArgs(query) }),
    ]);
    const reads = await prisma.userNotification.groupBy({
      by: ["notificationId"],
      where: { notificationId: { in: items.map((i) => i.id) }, readAt: { not: null } },
      _count: { _all: true },
    });
    const readBy = new Map(reads.map((r) => [r.notificationId, r._count._all]));
    return reply.send({ data: paged(items.map((n) => ({ ...n, readCount: readBy.get(n.id) ?? 0 })), total, query), error: null });
  });

  app.get("/api/v1/admin/notifications/:id", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const notification = await prisma.notification.findUnique({ where: { id: params.id } });
    if (!notification) return sendError(reply, 404, "NOTIFICATION_NOT_FOUND", "Notification not found");
    const [inApp, read, dismissed, emailFailures] = await Promise.all([
      prisma.userNotification.count({ where: { notificationId: notification.id } }),
      prisma.userNotification.count({ where: { notificationId: notification.id, readAt: { not: null } } }),
      prisma.userNotification.count({ where: { notificationId: notification.id, dismissedAt: { not: null } } }),
      prisma.emailLog.findMany({ where: { notificationId: notification.id, status: "failed" }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return reply.send({ data: { ...notification, stats: { inApp, read, dismissed }, emailFailures }, error: null });
  });

  app.post("/api/v1/admin/notifications", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const body = parseOr400(createNotificationSchema, request.body, reply);
    if (!body) return;
    if (body.channels.includes("push") && !isPushConfigured()) {
      return sendError(reply, 400, "PUSH_NOT_CONFIGURED", "Browser push isn't configured (VAPID keys). Untick Push or configure it first.");
    }
    if (body.channels.includes("email") && !emailConfigStatus().provider) {
      return sendError(reply, 400, "EMAIL_NOT_CONFIGURED", "No email provider is configured. Untick Email or configure it first.");
    }
    const limit = await announcementLimiter.take([request.admin.id]);
    if (!limit.ok) return sendRateLimited(reply, limit.retryAfterSeconds);

    const notification = await createNotification(body, request.admin);
    await audit(request, {
      action: "notification.create",
      targetType: "notification",
      targetId: notification.id,
      summary: `${body.title} → ${body.audience.type} (${notification.recipientCount} recipients) via ${body.channels.join(", ")}`,
      metadata: { audience: body.audience, channels: body.channels, emailCategory: body.emailCategory, actionUrl: body.actionUrl ?? null },
    });
    return reply.code(201).send({ data: notification, error: null });
  });

  app.get("/api/v1/admin/email/logs", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const query = parseOr400(emailLogQuery, request.query, reply);
    if (!query) return;
    const where: Prisma.EmailLogWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.kind && { kind: query.kind }),
      ...(query.q && { toEmail: { contains: query.q, mode: "insensitive" } }),
    };
    const [total, items] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(query) }),
    ]);
    return reply.send({ data: paged(items, total, query), error: null });
  });

  app.post("/api/v1/admin/email/test", { preHandler: requirePermission("notifications:send") }, async (request, reply) => {
    const body = parseOr400(z.object({ to: z.string().trim().email().optional() }), request.body, reply);
    if (!body) return;
    const limit = await testEmailLimiter.take([request.admin.id]);
    if (!limit.ok) return sendRateLimited(reply, limit.retryAfterSeconds);

    const to = body.to ?? request.admin.email;
    const result = await sendEmail({ to, kind: "test", ...testEmail(request.admin.email) });
    await audit(request, { action: "email.test", targetType: "email", summary: `Test email to ${to}: ${result.status}`, metadata: { to, result } });
    return reply.send({ data: { to, ...result }, error: null });
  });
}
