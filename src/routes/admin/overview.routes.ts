import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { billingProUserFilter, noBillingProUserFilter, proUserFilter } from "../../services/notification.service";
import { polarRevenue } from "../../services/polar/admin.service";
import { daysAgo, parseOr400 } from "./helpers";

// The dashboard's numbers. Each block says where it comes from:
//   database   — counted from GoMoxie's own tables right now
//   polar_api  — fetched live from Polar (can be unavailable)
//   tracked    — only covers events recorded since tracking was added
// Nothing is estimated or filled in when a source has no data.

const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const POLAR_TIMEOUT_MS = 8000;

async function polarRevenueWithTimeout(from: Date, to: Date) {
  try {
    const result = await Promise.race([
      polarRevenue(from, to),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Polar didn't answer in time")), POLAR_TIMEOUT_MS)),
    ]);
    return { available: true as const, source: "polar_api" as const, ...result };
  } catch (err) {
    return { available: false as const, source: "polar_api" as const, error: err instanceof Error ? err.message : "Polar unavailable" };
  }
}

export async function adminOverviewRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/overview", { preHandler: requirePermission("overview:read") }, async (request, reply) => {
    const q = parseOr400(query, request.query, reply);
    if (!q) return;
    const now = new Date();
    const since = daysAgo(q.days);
    const day = 24 * 60 * 60 * 1000;

    const [
      totalUsers,
      newUsers,
      verifiedUsers,
      suspendedUsers,
      adminUsers,
      proUsers,
      paidUsers,
      cancellingUsers,
      lapsedUsers,
      statusCounts,
      totalCvs,
      newCvs,
      newAiCvs,
      totalProfiles,
      freeUsage,
      freeExhausted,
      chapaSuccess,
      chapaStatus,
      signupsByDay,
      aiStatus,
      firstAiEvent,
      polar,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
      prisma.user.count({ where: { status: "SUSPENDED" } }),
      prisma.user.count({ where: { role: "ADMIN" } }),
      prisma.user.count({ where: proUserFilter(now) }),
      prisma.user.count({ where: billingProUserFilter(now) }),
      prisma.user.count({ where: { AND: [billingProUserFilter(now), { subscriptionCancelAtPeriodEnd: true }] } }),
      prisma.user.count({ where: { AND: [{ subscriptionProvider: { not: null } }, noBillingProUserFilter(now)] } }),
      prisma.user.groupBy({ by: ["subscriptionStatus"], where: { subscriptionStatus: { not: null } }, _count: { _all: true } }),
      prisma.cVDocument.count(),
      prisma.cVDocument.count({ where: { createdAt: { gte: since } } }),
      prisma.cVDocument.count({ where: { createdAt: { gte: since }, source: "ai" } }),
      prisma.careerProfile.count(),
      prisma.user.aggregate({ _sum: { freeCreateUses: true, freeTailorUses: true, freeImproveUses: true } }),
      Promise.all([
        prisma.user.count({ where: { freeCreateUses: { gt: 0 } } }),
        prisma.user.count({ where: { freeTailorUses: { gt: 0 } } }),
        prisma.user.count({ where: { freeImproveUses: { gt: 0 } } }),
      ]),
      prisma.payment.groupBy({ by: ["currency"], where: { status: "SUCCESS", createdAt: { gte: since } }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.payment.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.$queryRaw<{ day: Date; count: number }[]>`
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS count
        FROM "User" WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
      prisma.aiUsageEvent.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { totalTokens: true } }),
      prisma.aiUsageEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      polarRevenueWithTimeout(since, now),
    ]);

    const [recentUsers, recentPayments, webhookFailures, emailFailures, aiFailures, recentAudit] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, email: true, fullName: true, createdAt: true, emailVerifiedAt: true, googleId: true },
      }),
      prisma.payment.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
      prisma.webhookEvent.findMany({ where: { status: { in: ["failed", "unmatched"] } }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.emailLog.findMany({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.aiUsageEvent.findMany({
        where: { status: { in: ["provider_error", "timeout", "provider_rate_limited", "invalid_output"] } },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    ]);
    const paymentUsers = await prisma.user.findMany({
      where: { id: { in: recentPayments.map((p) => p.userId) } },
      select: { id: true, email: true },
    });
    const emailBy = new Map(paymentUsers.map((u) => [u.id, u.email]));

    // A dense series (zero days included) so the chart doesn't skip gaps.
    const byDayMap = new Map(signupsByDay.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.count]));
    const series: { day: string; count: number }[] = [];
    for (let t = since.getTime(); t <= now.getTime(); t += day) {
      const key = new Date(t).toISOString().slice(0, 10);
      series.push({ day: key, count: byDayMap.get(key) ?? 0 });
    }

    const aiCounts = Object.fromEntries(aiStatus.map((s) => [s.status, s._count._all]));

    return reply.send({
      data: {
        days: q.days,
        generatedAt: now,
        users: {
          source: "database",
          total: totalUsers,
          newInPeriod: newUsers,
          verified: verifiedUsers,
          unverified: totalUsers - verifiedUsers,
          suspended: suspendedUsers,
          admins: adminUsers,
          signupsByDay: series,
        },
        plans: {
          source: "database",
          pro: proUsers,
          paid: paidUsers,
          complimentary: proUsers - paidUsers,
          free: totalUsers - proUsers,
          cancellingAtPeriodEnd: cancellingUsers,
          lapsed: lapsedUsers,
          subscriptionStatus: Object.fromEntries(statusCounts.map((s) => [s.subscriptionStatus ?? "none", s._count._all])),
        },
        revenue: {
          chapa: {
            source: "database",
            successful: chapaSuccess.map((c) => ({ currency: c.currency, amount: c._sum.amount ?? 0, count: c._count._all })),
            byStatus: Object.fromEntries(chapaStatus.map((s) => [s.status, s._count._all])),
          },
          // Amounts in minor units (cents), as Polar reports them.
          polar,
        },
        content: {
          source: "database",
          totalCvs,
          cvsInPeriod: newCvs,
          aiCvsInPeriod: newAiCvs,
          totalProfiles,
          freeUsesSpent: {
            create: freeUsage._sum.freeCreateUses ?? 0,
            tailor: freeUsage._sum.freeTailorUses ?? 0,
            improve: freeUsage._sum.freeImproveUses ?? 0,
          },
          usersWhoUsedFree: { create: freeExhausted[0], tailor: freeExhausted[1], improve: freeExhausted[2] },
        },
        ai: {
          source: "tracked",
          trackingSince: firstAiEvent?.createdAt ?? null,
          success: aiCounts.success ?? 0,
          failed: (aiCounts.provider_error ?? 0) + (aiCounts.timeout ?? 0) + (aiCounts.provider_rate_limited ?? 0) + (aiCounts.invalid_output ?? 0),
          limitReached: aiCounts.limit_reached ?? 0,
          appRateLimited: aiCounts.app_rate_limited ?? 0,
          tokens: aiStatus.reduce((s, a) => s + (a._sum.totalTokens ?? 0), 0),
        },
        recent: {
          registrations: recentUsers.map((u) => ({
            id: u.id,
            email: u.email,
            fullName: u.fullName,
            createdAt: u.createdAt,
            verified: Boolean(u.emailVerifiedAt),
            google: Boolean(u.googleId),
          })),
          payments: recentPayments.map((p) => ({
            id: p.id,
            userId: p.userId,
            userEmail: emailBy.get(p.userId) ?? null,
            provider: p.provider,
            amount: p.amount,
            currency: p.currency,
            status: p.status,
            createdAt: p.createdAt,
          })),
          webhookFailures,
          emailFailures,
          aiFailures,
          audit: recentAudit,
        },
      },
      error: null,
    });
  });
}
