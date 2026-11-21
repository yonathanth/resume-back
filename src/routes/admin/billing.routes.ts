import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import { verifyAndSyncPayment } from "../../services/payment.service";
import { PaymentProviderError } from "../../services/payment";
import { cancelSubscriptionAtPeriodEnd, resumeSubscription, DodoSubscriptionError } from "../../services/dodo/subscription.service";
import { DodoNotConfiguredError } from "../../services/dodo/client";
import { applySubscriptionSnapshot, type DodoSubscriptionSnapshot } from "../../services/dodo/subscription-sync.service";
import {
  DodoAdminError,
  listDodoDisputes,
  listDodoOrders,
  listDodoRefunds,
  dodoLinks,
  resyncSubscriptionById,
  resyncUserSubscription,
} from "../../services/dodo/admin.service";
import { hasBillingPro } from "../../services/access.service";
import { findSubscriptionByProductId } from "../../services/billing/plans";

const PERIOD_NAME = { weekly: "Weekly", monthly: "Monthly", quarterly: "3 months" } as const;

/** "Pro · Monthly", "Plus · Weekly"; null when the product isn't one of ours. */
function subscriptionPlanName(u: { subscriptionProvider: string | null; dodoProductId: string | null }): string | null {
  if (u.subscriptionProvider === "CHAPA") return "Plus · 1 month (Chapa)";
  if (u.subscriptionProvider === "POLAR") return "Retired (Polar sandbox)";
  const plan = findSubscriptionByProductId(u.dodoProductId);
  if (!plan) return null;
  return `${plan.tier === "pro" ? "Pro" : "Plus"} · ${PERIOD_NAME[plan.period]}${plan.legacy ? " (old price)" : ""}`;
}
import { noBillingProUserFilter } from "../../services/notification.service";
import { audit, isoDate, paged, pageArgs, paginationSchema, parseOr400, reasonSchema, uuidParam } from "./helpers";

// What happens where:
//   Dodo  — the source of truth for card subscriptions, payments, refunds
//           and disputes. Read live from Dodo's API; cancel/resume call
//           Dodo's API; refunds and disputes are handled in the Dodo dashboard.
//   gomoxie — the User row mirrors the Dodo subscription (synced by webhook
//           or by "Sync from Dodo"); Chapa payments live in our Payment
//           table and are only ever confirmed by re-verifying with Chapa.
// Nothing here marks a payment successful or writes subscription status by hand.

const subscriptionsQuery = paginationSchema.extend({
  status: z.string().trim().max(40).optional(),
  provider: z.enum(["DODO", "CHAPA", "POLAR"]).optional(),
  // lapsed = had a subscription, no paid access now
  view: z.enum(["all", "active", "cancelling", "lapsed"]).default("all"),
  q: z.string().trim().max(200).optional(),
});

const paymentsQuery = paginationSchema.extend({
  status: z.enum(["PENDING", "SUCCESS", "FAILED", "CANCELLED", "EXPIRED"]).optional(),
  q: z.string().trim().max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const dodoOrdersQuery = paginationSchema.extend({
  status: z.enum(["pending", "paid", "refunded", "partially_refunded", "void", "draft"]).optional(),
  userId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const webhooksQuery = paginationSchema.extend({
  status: z.enum(["processed", "failed", "unmatched", "ignored", "received", "legacy"]).optional(),
});

function dodoError(reply: Parameters<typeof sendError>[0], err: unknown) {
  if (err instanceof DodoNotConfiguredError) {
    return sendError(reply, 503, "DODO_NOT_CONFIGURED", "Dodo Payments isn't configured (DODO_PAYMENTS_API_KEY is empty)");
  }
  if (err instanceof DodoAdminError || err instanceof DodoSubscriptionError) {
    return sendError(reply, 502, "DODO_UNAVAILABLE", `Dodo API error: ${err.message}`);
  }
  throw err;
}

/** The cancel/resume response the admin UI shows. */
const toCancelResult = (sub: DodoSubscriptionSnapshot) => ({
  status: sub.status,
  currentPeriodEnd: sub.next_billing_date,
  cancelAtPeriodEnd: sub.cancel_at_next_billing_date,
});

/** Narrows a Dodo list to one user: their stored Dodo customer id (none → nothing to list). */
async function dodoCustomerFilter(userId: string | undefined) {
  if (!userId) return {};
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { dodoCustomerId: true } });
  return { userFilter: true, dodoCustomerId: user?.dodoCustomerId ?? null };
}

export async function adminBillingRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/billing/summary", { preHandler: requirePermission("billing:read") }, async (_request, reply) => {
    const now = new Date();
    const [statusCounts, providerCounts, cancelling, paymentCounts, paymentSums, webhookCounts, links] = await Promise.all([
      prisma.user.groupBy({ by: ["subscriptionStatus"], where: { subscriptionStatus: { not: null } }, _count: { _all: true } }),
      prisma.user.groupBy({ by: ["subscriptionProvider"], where: { subscriptionProvider: { not: null } }, _count: { _all: true } }),
      prisma.user.count({
        where: { subscriptionStatus: "active", subscriptionCancelAtPeriodEnd: true, OR: [{ subscriptionCurrentPeriodEnd: null }, { subscriptionCurrentPeriodEnd: { gte: now } }] },
      }),
      prisma.payment.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.payment.groupBy({ by: ["currency"], where: { status: "SUCCESS" }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.webhookEvent.groupBy({ by: ["status"], _count: { _all: true } }),
      dodoLinks(),
    ]);
    const users = await prisma.user.findMany({
      where: { subscriptionStatus: { not: null } },
      select: { subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, subscriptionProvider: true },
    });
    const activePaid = users.filter((u) => hasBillingPro(u, now)).length;
    return reply.send({
      data: {
        subscriptions: {
          activePaid,
          cancellingAtPeriodEnd: cancelling,
          lapsed: users.filter((u) => u.subscriptionProvider && !hasBillingPro(u, now)).length,
          byStatus: Object.fromEntries(statusCounts.map((s) => [s.subscriptionStatus ?? "none", s._count._all])),
          byProvider: Object.fromEntries(providerCounts.map((s) => [s.subscriptionProvider ?? "none", s._count._all])),
        },
        chapa: {
          byStatus: Object.fromEntries(paymentCounts.map((p) => [p.status, p._count._all])),
          successfulRevenue: paymentSums.map((s) => ({ currency: s.currency, amount: s._sum.amount ?? 0, count: s._count._all })),
        },
        webhooks: Object.fromEntries(webhookCounts.map((w) => [w.status ?? "legacy", w._count._all])),
        dodo: links,
      },
      error: null,
    });
  });

  // The local mirror of each user's subscription (as last synced).
  app.get("/api/v1/admin/billing/subscriptions", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(subscriptionsQuery, request.query, reply);
    if (!query) return;
    const now = new Date();
    const and: Prisma.UserWhereInput[] = [{ subscriptionStatus: { not: null } }];
    if (query.status) and.push({ subscriptionStatus: query.status });
    if (query.provider) and.push({ subscriptionProvider: query.provider });
    if (query.q) and.push({ OR: [{ email: { contains: query.q, mode: "insensitive" } }, { dodoSubscriptionId: query.q }, { dodoCustomerId: query.q }] });
    const notExpired: Prisma.UserWhereInput = { OR: [{ subscriptionCurrentPeriodEnd: null }, { subscriptionCurrentPeriodEnd: { gte: now } }] };
    if (query.view === "active") and.push({ subscriptionStatus: "active", ...notExpired });
    if (query.view === "cancelling") and.push({ subscriptionStatus: "active", subscriptionCancelAtPeriodEnd: true, ...notExpired });
    if (query.view === "lapsed") {
      and.push({ subscriptionProvider: { not: null } });
      and.push(noBillingProUserFilter(now));
    }
    const where = { AND: and };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { subscriptionCurrentPeriodEnd: { sort: "desc", nulls: "last" } },
        ...pageArgs(query),
        select: {
          id: true,
          email: true,
          fullName: true,
          subscriptionProvider: true,
          subscriptionStatus: true,
          subscriptionCurrentPeriodEnd: true,
          subscriptionCancelAtPeriodEnd: true,
          dodoSubscriptionId: true,
          dodoCustomerId: true,
          dodoProductId: true,
        },
      }),
    ]);
    return reply.send({
      data: paged(
        users.map((u) => ({ ...u, hasPaidAccess: hasBillingPro(u, now), planName: subscriptionPlanName(u) })),
        total,
        query
      ),
      error: null,
    });
  });

  // Chapa payments (our own Payment table).
  app.get("/api/v1/admin/billing/payments", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(paymentsQuery, request.query, reply);
    if (!query) return;
    const and: Prisma.PaymentWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.from || query.to) and.push({ createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) } });
    if (query.q) {
      const matchingUsers = await prisma.user.findMany({ where: { email: { contains: query.q, mode: "insensitive" } }, select: { id: true }, take: 200 });
      and.push({
        OR: [
          { id: query.q },
          { merchantReference: query.q },
          { providerReference: query.q },
          { userId: query.q },
          { userId: { in: matchingUsers.map((u) => u.id) } },
        ],
      });
    }
    const where = and.length ? { AND: and } : {};
    const [total, payments] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(query) }),
    ]);
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.userId))] } }, select: { id: true, email: true } });
    const emailBy = new Map(users.map((u) => [u.id, u.email]));
    return reply.send({
      data: paged(
        payments.map((p) => ({
          id: p.id,
          userId: p.userId,
          userEmail: emailBy.get(p.userId) ?? null,
          provider: p.provider,
          productType: p.productType,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          merchantReference: p.merchantReference,
          providerReference: p.providerReference,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        total,
        query
      ),
      error: null,
    });
  });

  // Re-checks a pending Chapa payment with Chapa. Only Chapa's own answer
  // can move it to SUCCESS (which then grants the Pro period as usual).
  app.post("/api/v1/admin/billing/payments/:id/verify", { preHandler: requirePermission("billing:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const payment = await prisma.payment.findUnique({ where: { id: params.id } });
    if (!payment) return sendError(reply, 404, "PAYMENT_NOT_FOUND", "Payment not found");
    try {
      const updated = await verifyAndSyncPayment(payment);
      await audit(request, {
        action: "billing.chapa_reverify",
        targetType: "user",
        targetId: payment.userId,
        summary: `Payment ${payment.id}: ${payment.status} → ${updated.status}`,
        metadata: { paymentId: payment.id, before: { status: payment.status }, after: { status: updated.status } },
      });
      return reply.send({ data: { id: updated.id, status: updated.status, changed: updated.status !== payment.status }, error: null });
    } catch (err) {
      if (err instanceof PaymentProviderError) return sendError(reply, 502, "CHAPA_UNAVAILABLE", `Chapa verification failed: ${err.message}`);
      throw err;
    }
  });

  app.get("/api/v1/admin/billing/dodo/orders", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(dodoOrdersQuery, request.query, reply);
    if (!query) return;
    try {
      const result = await listDodoOrders({
        page: query.page,
        limit: query.pageSize,
        status: query.status,
        ...(await dodoCustomerFilter(query.userId)),
        createdAfter: query.from?.toISOString(),
        createdBefore: query.to?.toISOString(),
      });
      return reply.send({ data: { ...result, page: query.page, pageSize: query.pageSize }, error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });

  app.get("/api/v1/admin/billing/dodo/refunds", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(paginationSchema.extend({ userId: z.string().uuid().optional() }), request.query, reply);
    if (!query) return;
    try {
      return reply.send({ data: await listDodoRefunds({ page: query.page, limit: query.pageSize, ...(await dodoCustomerFilter(query.userId)) }), error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });

  app.get("/api/v1/admin/billing/dodo/disputes", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(paginationSchema, request.query, reply);
    if (!query) return;
    try {
      return reply.send({ data: await listDodoDisputes({ page: query.page, limit: query.pageSize }), error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });

  app.get("/api/v1/admin/billing/webhooks", { preHandler: requirePermission("billing:read") }, async (request, reply) => {
    const query = parseOr400(webhooksQuery, request.query, reply);
    if (!query) return;
    const where: Prisma.WebhookEventWhereInput = query.status ? { status: query.status === "legacy" ? null : query.status } : {};
    const [total, items] = await Promise.all([
      prisma.webhookEvent.count({ where }),
      prisma.webhookEvent.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(query) }),
    ]);
    return reply.send({ data: paged(items, total, query), error: null });
  });

  // Recovery for a failed/unmatched subscription webhook: re-fetch the
  // subscription from Dodo's API (not the old payload) and apply it.
  app.post("/api/v1/admin/billing/webhooks/:id/retry", { preHandler: requirePermission("billing:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const event = await prisma.webhookEvent.findUnique({ where: { id: params.id } });
    if (!event) return sendError(reply, 404, "WEBHOOK_NOT_FOUND", "Webhook event not found");
    if (event.provider !== "DODO" || !event.resourceId || !event.eventType?.startsWith("subscription.")) {
      return sendError(reply, 400, "NOT_RETRYABLE", "Only Dodo subscription events can be re-synced. Failed payments are retried by Dodo itself.");
    }
    try {
      const result = await resyncSubscriptionById(event.resourceId);
      const status = result.userId ? "processed" : "unmatched";
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status, error: result.userId ? null : "Still no matching gomoxie user", processedAt: new Date() },
      });
      await audit(request, {
        action: "billing.webhook_retry",
        targetType: result.userId ? "user" : "webhook",
        targetId: result.userId ?? event.id,
        summary: `Re-synced Dodo subscription ${event.resourceId}: ${result.status}`,
        metadata: { webhookEventId: event.id, before: { status: event.status }, after: { status }, dodo: result },
      });
      return reply.send({ data: { status, dodo: result }, error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });

  // Reconcile one user: Dodo subscription from Dodo's API, plus a
  // re-verify of any pending Chapa payments.
  app.post("/api/v1/admin/users/:id/billing/sync", { preHandler: requirePermission("billing:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const user = await prisma.user.findUnique({ where: { id: params.id } });
    if (!user) return sendError(reply, 404, "USER_NOT_FOUND", "User not found");

    const before = { status: user.subscriptionStatus, periodEnd: user.subscriptionCurrentPeriodEnd, cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd };
    let dodo: unknown = null;
    let dodoFailure: string | null = null;
    try {
      dodo = await resyncUserSubscription(user);
    } catch (err) {
      dodoFailure = err instanceof Error ? err.message : "Dodo sync failed";
    }

    const pending = await prisma.payment.findMany({ where: { userId: user.id, status: "PENDING" } });
    const chapa: { id: string; before: string; after: string; error?: string }[] = [];
    for (const payment of pending) {
      try {
        const updated = await verifyAndSyncPayment(payment);
        chapa.push({ id: payment.id, before: payment.status, after: updated.status });
      } catch (err) {
        chapa.push({ id: payment.id, before: payment.status, after: payment.status, error: err instanceof Error ? err.message : "failed" });
      }
    }

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, subscriptionCancelAtPeriodEnd: true },
    });
    await audit(request, {
      action: "billing.sync",
      targetType: "user",
      targetId: user.id,
      summary: dodoFailure ? `Dodo sync failed: ${dodoFailure}` : "Billing re-synced from providers",
      metadata: {
        before,
        after: { status: after?.subscriptionStatus, periodEnd: after?.subscriptionCurrentPeriodEnd, cancelAtPeriodEnd: after?.subscriptionCancelAtPeriodEnd },
        dodo,
        chapa,
      },
    });
    return reply.send({ data: { dodo, dodoError: dodoFailure, chapa }, error: null });
  });

  // Dodo-side: schedule cancellation at period end (no refund, access until then).
  app.post("/api/v1/admin/users/:id/subscription/cancel", { preHandler: requirePermission("billing:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(z.object({ reason: reasonSchema }), request.body, reply);
    if (!params || !body) return;
    const user = await prisma.user.findUnique({ where: { id: params.id } });
    if (!user) return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    if (!user.dodoSubscriptionId) return sendError(reply, 404, "NO_DODO_SUBSCRIPTION", "This user has no Dodo subscription");
    try {
      const updated = await cancelSubscriptionAtPeriodEnd(user.dodoSubscriptionId);
      await applySubscriptionSnapshot(updated);
      const result = toCancelResult(updated);
      await audit(request, {
        action: "billing.cancel_at_period_end",
        targetType: "user",
        targetId: user.id,
        summary: body.reason,
        metadata: { dodoSubscriptionId: user.dodoSubscriptionId, before: { cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd }, after: result },
      });
      return reply.send({ data: result, error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });

  app.post("/api/v1/admin/users/:id/subscription/resume", { preHandler: requirePermission("billing:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(z.object({ reason: reasonSchema }), request.body, reply);
    if (!params || !body) return;
    const user = await prisma.user.findUnique({ where: { id: params.id } });
    if (!user) return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    if (!user.dodoSubscriptionId) return sendError(reply, 404, "NO_DODO_SUBSCRIPTION", "This user has no Dodo subscription");
    try {
      const updated = await resumeSubscription(user.dodoSubscriptionId);
      await applySubscriptionSnapshot(updated);
      const result = toCancelResult(updated);
      await audit(request, {
        action: "billing.resume",
        targetType: "user",
        targetId: user.id,
        summary: body.reason,
        metadata: { dodoSubscriptionId: user.dodoSubscriptionId, after: result },
      });
      return reply.send({ data: result, error: null });
    } catch (err) {
      return dodoError(reply, err);
    }
  });
}
