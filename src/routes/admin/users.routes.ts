import type { FastifyInstance } from "fastify";
import type { Prisma, User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import { revokeAllSessions } from "../../services/session.service";
import { computeAccess } from "../../services/access.service";
import { FLOW_TYPES, getSettings } from "../../services/settings.service";
import { issueVerificationCode } from "../../services/emailVerification.service";
import { sendPasswordResetEmail } from "../../services/passwordReset.service";
import { deleteUserAccount, hasRenewingPolarSubscription } from "../../services/accountDeletion.service";
import { billingProUserFilter, freeUserFilter, grantOnlyProUserFilter, proUserFilter } from "../../services/notification.service";
import { isAdminRole } from "../../services/admin/permissions";
import { audit, isoDate, paged, pageArgs, paginationSchema, parseOr400, reasonSchema, uuidParam } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  verified: z.enum(["true", "false"]).optional(),
  // pro = paid or granted, paid = billing only, grant = granted without billing, free = no Pro
  plan: z.enum(["pro", "paid", "grant", "free"]).optional(),
  role: z.enum(["USER", "ADMIN"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(["newest", "oldest", "lastActive", "email"]).default("newest"),
});

const reasonBody = z.object({ reason: reasonSchema });
const optionalReasonBody = z.object({ reason: z.string().trim().max(500).optional() });
const usageResetBody = z.object({ flows: z.array(z.enum(FLOW_TYPES)).min(1), reason: reasonSchema });
const deleteBody = z.object({ confirmEmail: z.string().trim().min(1), reason: reasonSchema });

const USER_LIST_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastActiveAt: true,
  lastLoginAt: true,
  googleId: true,
  passwordHash: true,
  subscriptionProvider: true,
  subscriptionStatus: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionCancelAtPeriodEnd: true,
  freeCreateUses: true,
  freeTailorUses: true,
  freeImproveUses: true,
  polarProductId: true,
  usagePeriodKey: true,
  periodCreateUses: true,
  periodTailorUses: true,
  periodImproveUses: true,
  _count: { select: { profiles: true } },
} satisfies Prisma.UserSelect;

/** Loads the target user, refusing actions on admins and on yourself where that would be unsafe. */
type TargetResult = { ok: false; error: { status: number; code: string; message: string } } | { ok: true; user: User };

async function loadTarget(id: string, opts: { forbidAdmins?: boolean; adminId?: string } = {}): Promise<TargetResult> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return { ok: false, error: { status: 404, code: "USER_NOT_FOUND", message: "User not found" } };
  if (opts.adminId && user.id === opts.adminId && opts.forbidAdmins) {
    return { ok: false, error: { status: 400, code: "CANNOT_TARGET_SELF", message: "You can't do this to your own account" } };
  }
  if (opts.forbidAdmins && isAdminRole(user.role)) {
    return { ok: false, error: { status: 400, code: "CANNOT_TARGET_ADMIN", message: "Admin accounts can't be changed from the dashboard. Use the server script." } };
  }
  return { ok: true, user };
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/users", { preHandler: requirePermission("users:read") }, async (request, reply) => {
    const query = parseOr400(listQuery, request.query, reply);
    if (!query) return;
    const now = new Date();

    const and: Prisma.UserWhereInput[] = [];
    if (query.q) {
      const or: Prisma.UserWhereInput[] = [
        { email: { contains: query.q, mode: "insensitive" } },
        { fullName: { contains: query.q, mode: "insensitive" } },
      ];
      if (UUID_RE.test(query.q)) or.push({ id: query.q });
      and.push({ OR: or });
    }
    if (query.status) and.push({ status: query.status });
    if (query.role) and.push({ role: query.role });
    if (query.verified) and.push({ emailVerifiedAt: query.verified === "true" ? { not: null } : null });
    if (query.from || query.to) and.push({ createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) } });
    if (query.plan === "pro") and.push(proUserFilter(now));
    if (query.plan === "paid") and.push(billingProUserFilter(now));
    if (query.plan === "free") and.push(freeUserFilter(now));
    if (query.plan === "grant") and.push(grantOnlyProUserFilter(now));

    const where: Prisma.UserWhereInput = and.length ? { AND: and } : {};
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sort === "oldest"
        ? [{ createdAt: "asc" }]
        : query.sort === "lastActive"
          ? [{ lastActiveAt: { sort: "desc", nulls: "last" } }]
          : query.sort === "email"
            ? [{ email: "asc" }]
            : [{ createdAt: "desc" }];

    const [total, users, settings] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy, ...pageArgs(query), select: USER_LIST_SELECT }),
      getSettings(),
    ]);

    const ids = users.map((u) => u.id);
    const [grants, cvCounts] = await Promise.all([
      prisma.entitlement.findMany({ where: { userId: { in: ids }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
      prisma.cVDocument.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: { _all: true } }),
    ]);
    const cvCountBy = new Map(cvCounts.map((c) => [c.userId, c._count._all]));

    const items = users.map((u) => {
      const access = computeAccess(u, grants.filter((g) => g.userId === u.id), settings, now);
      return {
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        status: u.status,
        emailVerified: Boolean(u.emailVerifiedAt),
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        lastLoginAt: u.lastLoginAt,
        signInMethods: [u.passwordHash ? "password" : null, u.googleId ? "google" : null].filter(Boolean),
        isPro: access.isPro,
        tier: access.tier,
        proSource: access.proSource,
        subscriptionProvider: u.subscriptionProvider,
        subscriptionStatus: u.subscriptionStatus,
        cvCount: cvCountBy.get(u.id) ?? 0,
        profileCount: u._count.profiles,
      };
    });

    return reply.send({ data: paged(items, total, query), error: null });
  });

  app.get("/api/v1/admin/users/:id", { preHandler: requirePermission("users:read") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const now = new Date();

    const user = await prisma.user.findUnique({
      where: { id: params.id },
      include: {
        _count: { select: { profiles: true, pushSubscriptions: true, notifications: true } },
        entitlements: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!user) return sendError(reply, 404, "USER_NOT_FOUND", "User not found");

    const [settings, cvStats, importCount, activeSessions, payments, aiEvents, aiTotals, emails, auditEntries] = await Promise.all([
      getSettings(),
      prisma.cVDocument.groupBy({ by: ["source"], where: { userId: user.id }, _count: { _all: true } }),
      prisma.cVImport.count({ where: { userId: user.id } }),
      prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } } }),
      prisma.payment.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.aiUsageEvent.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.aiUsageEvent.groupBy({ by: ["status"], where: { userId: user.id }, _count: { _all: true }, _sum: { totalTokens: true } }),
      prisma.emailLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 15 }),
      prisma.adminAuditLog.findMany({ where: { targetType: "user", targetId: user.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    ]);

    const access = computeAccess(user, user.entitlements, settings, now);
    const liveIds = new Set(access.activeGrantIds);

    return reply.send({
      data: {
        account: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          occupationTitle: user.occupationTitle,
          professions: user.professions,
          role: user.role,
          status: user.status,
          suspendedAt: user.suspendedAt,
          suspensionReason: user.suspensionReason,
          emailVerifiedAt: user.emailVerifiedAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          lastLoginAt: user.lastLoginAt,
          lastActiveAt: user.lastActiveAt,
          onboardingCompletedAt: user.onboardingCompletedAt,
          signupIntent: user.signupIntent,
          careerStage: user.careerStage,
          acquisitionSource: user.acquisitionSource,
          acquisitionDetail: user.acquisitionDetail,
          signupSurface: user.signupSurface,
          signupAttribution: user.signupAttribution,
          hasPassword: Boolean(user.passwordHash),
          hasGoogle: Boolean(user.googleId),
          emailAnnouncementsOptOut: user.emailAnnouncementsOptOut,
          activeSessions,
          pushDevices: user._count.pushSubscriptions,
        },
        content: {
          cvCount: cvStats.reduce((sum, s) => sum + s._count._all, 0),
          cvBySource: Object.fromEntries(cvStats.map((s) => [s.source, s._count._all])),
          profileCount: user._count.profiles,
          importCount,
        },
        access: {
          ...access,
          planDefaults: settings.plans,
        },
        subscription: {
          provider: user.subscriptionProvider,
          status: user.subscriptionStatus,
          currentPeriodEnd: user.subscriptionCurrentPeriodEnd,
          cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd,
          polarCustomerId: user.polarCustomerId,
          polarSubscriptionId: user.polarSubscriptionId,
          polarProductId: user.polarProductId,
          renewingPolar: hasRenewingPolarSubscription(user),
        },
        entitlements: user.entitlements.map((e) => ({ ...e, active: liveIds.has(e.id) })),
        payments: payments.map((p) => ({
          id: p.id,
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
        ai: {
          totals: aiTotals.map((t) => ({ status: t.status, count: t._count._all, tokens: t._sum.totalTokens ?? 0 })),
          recent: aiEvents,
        },
        emails,
        audit: auditEntries,
      },
      error: null,
    });
  });

  app.post("/api/v1/admin/users/:id/verify-email", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(reasonBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);
    if (target.user.emailVerifiedAt) return sendError(reply, 409, "ALREADY_VERIFIED", "This email is already verified");

    await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({ where: { userId: target.user.id } }),
      prisma.user.update({ where: { id: target.user.id }, data: { emailVerifiedAt: new Date() } }),
    ]);
    await audit(request, { action: "user.verify_email", targetType: "user", targetId: target.user.id, summary: body.reason, metadata: { email: target.user.email } });
    return reply.send({ data: { success: true }, error: null });
  });

  app.post("/api/v1/admin/users/:id/resend-verification", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    if (!params) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);
    if (target.user.emailVerifiedAt) return sendError(reply, 409, "ALREADY_VERIFIED", "This email is already verified");

    try {
      await issueVerificationCode(target.user);
    } catch (err) {
      return sendError(reply, 502, "EMAIL_FAILED", `The email could not be sent: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    await audit(request, { action: "user.resend_verification", targetType: "user", targetId: target.user.id });
    return reply.send({ data: { success: true }, error: null });
  });

  // Suspension keeps every bit of the user's data. All sessions end now;
  // requireAuth refuses the account's still-valid access tokens on the very
  // next request, and sign-in and refresh are refused until reactivation.
  app.post("/api/v1/admin/users/:id/suspend", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(reasonBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id, { forbidAdmins: true, adminId: request.admin.id });
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);
    if (target.user.status === "SUSPENDED") return sendError(reply, 409, "ALREADY_SUSPENDED", "This account is already suspended");

    await prisma.user.update({
      where: { id: target.user.id },
      data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: body.reason },
    });
    await revokeAllSessions(target.user.id);
    await audit(request, {
      action: "user.suspend",
      targetType: "user",
      targetId: target.user.id,
      summary: body.reason,
      metadata: { email: target.user.email, before: { status: target.user.status }, after: { status: "SUSPENDED" } },
    });
    return reply.send({ data: { success: true }, error: null });
  });

  app.post("/api/v1/admin/users/:id/reactivate", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(reasonBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);
    if (target.user.status !== "SUSPENDED") return sendError(reply, 409, "NOT_SUSPENDED", "This account isn't suspended");

    await prisma.user.update({
      where: { id: target.user.id },
      data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null },
    });
    await audit(request, {
      action: "user.reactivate",
      targetType: "user",
      targetId: target.user.id,
      summary: body.reason,
      metadata: {
        email: target.user.email,
        before: { status: "SUSPENDED", suspensionReason: target.user.suspensionReason },
        after: { status: "ACTIVE" },
      },
    });
    return reply.send({ data: { success: true }, error: null });
  });

  app.post("/api/v1/admin/users/:id/revoke-sessions", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(optionalReasonBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);

    await revokeAllSessions(target.user.id);
    await audit(request, { action: "user.revoke_sessions", targetType: "user", targetId: target.user.id, summary: body.reason });
    return reply.send({ data: { success: true }, error: null });
  });

  // Emails the user a one-time reset link. The admin never sees or chooses the password.
  app.post("/api/v1/admin/users/:id/password-reset", { preHandler: requirePermission("users:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(optionalReasonBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);

    const result = await sendPasswordResetEmail(target.user, request.admin.id);
    await audit(request, {
      action: "user.password_reset_sent",
      targetType: "user",
      targetId: target.user.id,
      summary: body.reason,
      metadata: { emailStatus: result.status },
    });
    if (result.status === "failed") {
      return sendError(reply, 502, "EMAIL_FAILED", `The reset email could not be sent: ${result.error}`);
    }
    return reply.send({ data: { success: true, delivery: result.status }, error: null });
  });

  app.post("/api/v1/admin/users/:id/usage/reset", { preHandler: requirePermission("entitlements:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(usageResetBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id);
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);

    const data: Prisma.UserUpdateInput = {};
    const before: Record<string, number> = {};
    for (const flow of body.flows) {
      if (flow === "create") {
        before.create = target.user.freeCreateUses;
        Object.assign(data, { freeCreateUses: 0, freeCreateUsed: false, periodCreateUses: 0 });
      } else if (flow === "tailor") {
        before.tailor = target.user.freeTailorUses;
        Object.assign(data, { freeTailorUses: 0, freeTailorUsed: false, periodTailorUses: 0 });
      } else {
        before.improve = target.user.freeImproveUses;
        Object.assign(data, { freeImproveUses: 0, freeImproveUsed: false, periodImproveUses: 0 });
      }
    }
    await prisma.user.update({ where: { id: target.user.id }, data });
    await audit(request, {
      action: "user.usage_reset",
      targetType: "user",
      targetId: target.user.id,
      summary: body.reason,
      metadata: { flows: body.flows, before, after: Object.fromEntries(body.flows.map((f) => [f, 0])) },
    });
    return reply.send({ data: { success: true }, error: null });
  });

  // Permanent. Same rules as a user deleting their own account (see
  // accountDeletion.service.ts): a still-renewing Polar subscription must be
  // cancelled first so the customer isn't billed for a deleted account.
  app.delete("/api/v1/admin/users/:id", { preHandler: requirePermission("users:delete") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(deleteBody, request.body, reply);
    if (!params || !body) return;
    const target = await loadTarget(params.id, { forbidAdmins: true, adminId: request.admin.id });
    if (!target.ok) return sendError(reply, target.error.status, target.error.code, target.error.message);
    const user = target.user;

    if (body.confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
      return sendError(reply, 400, "CONFIRMATION_MISMATCH", "Type the user's email exactly to confirm");
    }
    if (hasRenewingPolarSubscription(user)) {
      return sendError(
        reply,
        409,
        "ACTIVE_SUBSCRIPTION",
        "This user has a Polar subscription that will renew. Cancel it first (Billing → Cancel at period end), then delete the account."
      );
    }

    const [cvCount, profileCount, paymentCount] = await Promise.all([
      prisma.cVDocument.count({ where: { userId: user.id } }),
      prisma.careerProfile.count({ where: { userId: user.id } }),
      prisma.payment.count({ where: { userId: user.id } }),
    ]);
    await deleteUserAccount(user.id);
    await audit(request, {
      action: "user.delete",
      targetType: "user",
      targetId: user.id,
      summary: body.reason,
      metadata: { email: user.email, createdAt: user.createdAt, deleted: { cvCount, profileCount, paymentCount } },
    });
    return reply.send({ data: { success: true }, error: null });
  });
}
