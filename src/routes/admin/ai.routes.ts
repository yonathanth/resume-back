import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { getSettings } from "../../services/settings.service";
import { currentModelName, currentProviderName } from "../../services/ai/usage";
import { daysAgo, paged, pageArgs, paginationSchema, parseOr400 } from "./helpers";

// AI usage from AiUsageEvent (recorded server-side since this feature
// shipped — earlier activity isn't in it). Token counts are what the
// provider reported per call. Cost is an ESTIMATE from prices the admin
// enters in Settings; it is never the provider's invoice.

const rangeQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const FAILURE_STATUSES = ["provider_rate_limited", "timeout", "provider_error", "invalid_output"];

const eventsQuery = paginationSchema.extend({
  status: z.string().trim().max(40).optional(),
  operation: z.enum(["cv_generation", "polish_summary", "role_match", "jd_analysis", "cv_review", "cv_polish"]).optional(),
  userId: z.string().uuid().optional(),
});

export async function adminAiRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/ai/usage", { preHandler: requirePermission("ai:read") }, async (request, reply) => {
    const query = parseOr400(rangeQuery, request.query, reply);
    if (!query) return;
    const since = daysAgo(query.days);
    const where: Prisma.AiUsageEventWhereInput = { createdAt: { gte: since } };

    const [byStatus, byOperation, byModel, topUsers, limitHitters, byDay, firstEvent, settings] = await Promise.all([
      prisma.aiUsageEvent.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.aiUsageEvent.groupBy({ by: ["operation", "status"], where, _count: { _all: true } }),
      prisma.aiUsageEvent.groupBy({
        by: ["provider", "model"],
        where: { ...where, status: "success" },
        _count: { _all: true },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
        _avg: { latencyMs: true },
      }),
      prisma.aiUsageEvent.groupBy({
        by: ["userId"],
        where: { ...where, userId: { not: null }, status: "success" },
        _count: { _all: true },
        _sum: { totalTokens: true },
        orderBy: { _count: { userId: "desc" } },
        take: 10,
      }),
      prisma.aiUsageEvent.groupBy({
        by: ["userId"],
        where: { ...where, userId: { not: null }, status: { in: ["limit_reached", "app_rate_limited"] } },
        _count: { _all: true },
        orderBy: { _count: { userId: "desc" } },
        take: 10,
      }),
      prisma.$queryRaw<{ day: Date; status: string; count: number; tokens: number | null }[]>`
        SELECT date_trunc('day', "createdAt") AS day, "status", count(*)::int AS count, sum("totalTokens")::int AS tokens
        FROM "AiUsageEvent" WHERE "createdAt" >= ${since}
        GROUP BY 1, 2 ORDER BY 1`,
      prisma.aiUsageEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      getSettings(),
    ]);

    const userIds = [...new Set([...topUsers, ...limitHitters].map((u) => u.userId).filter((v): v is string => Boolean(v)))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
    const emailBy = new Map(users.map((u) => [u.id, u.email]));

    const prices = new Map(settings.aiPricing.models.map((m) => [m.model, m]));
    const models = byModel.map((m) => {
      const price = prices.get(m.model);
      const prompt = m._sum.promptTokens ?? 0;
      const completion = m._sum.completionTokens ?? 0;
      return {
        provider: m.provider,
        model: m.model,
        calls: m._count._all,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: m._sum.totalTokens ?? 0,
        avgLatencyMs: m._avg.latencyMs ? Math.round(m._avg.latencyMs) : null,
        estimatedCostUsd: price ? (prompt / 1e6) * price.inputPerMillionUsd + (completion / 1e6) * price.outputPerMillionUsd : null,
      };
    });

    const days = new Map<string, { day: string; success: number; failed: number; refused: number; tokens: number }>();
    for (const row of byDay) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      const entry = days.get(key) ?? { day: key, success: 0, failed: 0, refused: 0, tokens: 0 };
      if (row.status === "success") entry.success += row.count;
      else if (FAILURE_STATUSES.includes(row.status)) entry.failed += row.count;
      else entry.refused += row.count;
      entry.tokens += row.tokens ?? 0;
      days.set(key, entry);
    }

    const statusCounts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    const withPrice = models.filter((m) => m.estimatedCostUsd !== null);

    return reply.send({
      data: {
        days: query.days,
        trackingSince: firstEvent?.createdAt ?? null,
        current: { provider: currentProviderName(), model: currentModelName(), limits: settings.limits, paused: settings.platform.aiGenerationPaused },
        totals: {
          calls: models.reduce((s, m) => s + m.calls, 0) + FAILURE_STATUSES.reduce((s, k) => s + (statusCounts[k] ?? 0), 0),
          success: statusCounts.success ?? 0,
          failed: FAILURE_STATUSES.reduce((s, k) => s + (statusCounts[k] ?? 0), 0),
          limitReached: statusCounts.limit_reached ?? 0,
          appRateLimited: statusCounts.app_rate_limited ?? 0,
          paused: statusCounts.paused ?? 0,
          tokens: models.reduce((s, m) => s + m.totalTokens, 0),
          estimatedCostUsd: withPrice.length ? withPrice.reduce((s, m) => s + (m.estimatedCostUsd ?? 0), 0) : null,
          modelsWithoutPrice: models.filter((m) => m.estimatedCostUsd === null).map((m) => m.model),
        },
        byStatus: statusCounts,
        byOperation: byOperation.map((o) => ({ operation: o.operation, status: o.status, count: o._count._all })),
        models,
        byDay: [...days.values()],
        topUsers: topUsers.map((u) => ({ userId: u.userId, email: emailBy.get(u.userId!) ?? null, calls: u._count._all, tokens: u._sum.totalTokens ?? 0 })),
        limitHitters: limitHitters.map((u) => ({ userId: u.userId, email: emailBy.get(u.userId!) ?? null, count: u._count._all })),
      },
      error: null,
    });
  });

  app.get("/api/v1/admin/ai/events", { preHandler: requirePermission("ai:read") }, async (request, reply) => {
    const query = parseOr400(eventsQuery, request.query, reply);
    if (!query) return;
    const where: Prisma.AiUsageEventWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.operation && { operation: query.operation }),
      ...(query.userId && { userId: query.userId }),
    };
    const [total, items] = await Promise.all([
      prisma.aiUsageEvent.count({ where }),
      prisma.aiUsageEvent.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(query), include: { user: { select: { email: true } } } }),
    ]);
    return reply.send({ data: paged(items.map(({ user, ...e }) => ({ ...e, userEmail: user?.email ?? null })), total, query), error: null });
  });
}
