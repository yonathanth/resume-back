import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { proUserFilter } from "../../services/notification.service";
import {
  buildFunnel,
  buildSegments,
  ratingSummary,
  topAttribution,
  type CohortRow,
} from "../../services/admin/insights.service";
import { daysAgo, parseOr400 } from "./helpers";

// Insights: the activation funnel for accounts created in the period (a
// cohort, so each step is "of the people who signed up then"), how it
// differs by onboarding answer, where onboarding loses people, and what
// people told us. Database facts (CVs, verification, Pro) cover every
// account; event-based steps only cover what happened since tracking began
// (trackingSince), which the page says next to them.

const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export async function adminInsightsRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/insights", { preHandler: requirePermission("overview:read") }, async (request, reply) => {
    const q = parseOr400(query, request.query, reply);
    if (!q) return;
    const now = new Date();
    const since = daysAgo(q.days);

    const [cohort, proUsers, firstEvent, stepViews, stepSkips, tryEvents, ratings, drafts, deletions, comments, lifecycle, tourStarts] =
      await Promise.all([
        prisma.$queryRaw<CohortRow[]>`
          SELECT u."id", u."createdAt",
            u."emailVerifiedAt" IS NOT NULL AS "verified",
            u."onboardingCompletedAt" IS NOT NULL AS "onboarded",
            u."signupIntent", u."careerStage", u."acquisitionSource", u."signupSurface", u."signupAttribution",
            EXISTS (SELECT 1 FROM "CVDocument" d WHERE d."userId" = u."id") AS "hasCv",
            (EXISTS (SELECT 1 FROM "ProductEvent" e WHERE e."userId" = u."id" AND e."name" = 'pdf_downloaded')
              OR EXISTS (SELECT 1 FROM "CVDocument" f WHERE f."userId" = u."id" AND f."status" = 'final')) AS "downloaded",
            EXISTS (
              SELECT 1 FROM "ProductEvent" a
              WHERE a."userId" = u."id" AND a."name" = 'user_active'
                AND a."createdAt" >= u."createdAt" + interval '1 day'
                AND a."createdAt" < u."createdAt" + interval '8 days'
            ) AS "returned"
          FROM "User" u
          WHERE u."createdAt" >= ${since} AND u."role" = 'USER'`,
        prisma.user.findMany({ where: { AND: [proUserFilter(now), { createdAt: { gte: since } }] }, select: { id: true } }),
        prisma.productEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
        prisma.$queryRaw<{ step: string; users: number }[]>`
          SELECT e."props"->>'step' AS "step", count(DISTINCT e."userId")::int AS "users"
          FROM "ProductEvent" e
          WHERE e."name" = 'onboarding_step_viewed' AND e."createdAt" >= ${since}
          GROUP BY 1`,
        prisma.$queryRaw<{ step: string; users: number }[]>`
          SELECT e."props"->>'step' AS "step", count(DISTINCT e."userId")::int AS "users"
          FROM "ProductEvent" e
          WHERE e."name" = 'onboarding_skipped' AND e."createdAt" >= ${since}
          GROUP BY 1`,
        prisma.$queryRaw<{ name: string; flow: string; visitors: number }[]>`
          SELECT e."name", e."props"->>'flow' AS "flow", count(DISTINCT e."anonymousId")::int AS "visitors"
          FROM "ProductEvent" e
          WHERE e."name" IN ('try_started', 'try_signup_prompted') AND e."createdAt" >= ${since}
          GROUP BY 1, 2`,
        prisma.feedback.findMany({ where: { kind: "cv_rating", createdAt: { gte: since } }, select: { rating: true } }),
        prisma.feedback.groupBy({
          by: ["flowType", "rating", "reason"],
          where: { kind: "ai_draft", createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.feedback.groupBy({
          by: ["reason"],
          where: { kind: "account_deletion", createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.feedback.findMany({
          where: { createdAt: { gte: since }, comment: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 30,
          select: { id: true, kind: true, rating: true, reason: true, comment: true, flowType: true, userId: true, createdAt: true },
        }),
        prisma.lifecycleEmail.groupBy({
          by: ["kind", "status"],
          where: { createdAt: { gte: since }, status: { in: ["sent", "failed"] } },
          _count: { _all: true },
        }),
        prisma.productEvent.count({ where: { name: "tour_started", createdAt: { gte: since } } }),
      ]);

    const proIds = new Set(proUsers.map((u) => u.id));
    const tryCount = (name: string, flow: string) => tryEvents.find((e) => e.name === name && e.flow === flow)?.visitors ?? 0;
    const trySignups = (flow: string) => cohort.filter((r) => r.signupSurface === "try" && r.signupIntent === flow).length;

    // Thumbs on AI drafts, per flow.
    const draftByFlow = new Map<string, { up: number; down: number }>();
    const draftReasons = new Map<string, number>();
    for (const row of drafts) {
      const flow = row.flowType ?? "unknown";
      const entry = draftByFlow.get(flow) ?? { up: 0, down: 0 };
      if (row.rating === 1) entry.up += row._count._all;
      if (row.rating === -1) entry.down += row._count._all;
      draftByFlow.set(flow, entry);
      if (row.rating === -1 && row.reason) draftReasons.set(row.reason, (draftReasons.get(row.reason) ?? 0) + row._count._all);
    }

    const userIds = [...new Set(comments.map((c) => c.userId).filter((v): v is string => Boolean(v)))];
    const commenters = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
    const emailBy = new Map(commenters.map((u) => [u.id, u.email]));

    return reply.send({
      data: {
        days: q.days,
        generatedAt: now,
        trackingSince: firstEvent?.createdAt ?? null,
        funnel: buildFunnel(cohort, proIds, now),
        segments: {
          intent: buildSegments(cohort, proIds, (r) => r.signupIntent),
          careerStage: buildSegments(cohort, proIds, (r) => r.careerStage),
          source: buildSegments(cohort, proIds, (r) => r.acquisitionSource),
          surface: buildSegments(cohort, proIds, (r) => r.signupSurface),
        },
        attribution: {
          utmSource: topAttribution(cohort, "utmSource"),
          utmCampaign: topAttribution(cohort, "utmCampaign"),
          referrer: topAttribution(cohort, "referrer"),
          quickLink: topAttribution(cohort, "quickLink"),
        },
        onboarding: {
          steps: stepViews.map((s) => ({
            step: s.step,
            viewed: s.users,
            skipped: stepSkips.find((k) => k.step === s.step)?.users ?? 0,
          })),
        },
        tryFlows: (["create", "tailor", "improve"] as const).map((flow) => ({
          flow,
          started: tryCount("try_started", flow),
          askedToSignUp: tryCount("try_signup_prompted", flow),
          signedUp: trySignups(flow),
        })),
        tourStarts,
        feedback: {
          cvRating: ratingSummary(ratings),
          aiDraft: {
            byFlow: [...draftByFlow.entries()].map(([flow, counts]) => ({ flow, ...counts })),
            downReasons: [...draftReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
          },
          deletion: {
            count: deletions.reduce((sum, d) => sum + d._count._all, 0),
            reasons: deletions
              .map((d) => ({ reason: d.reason ?? "not_given", count: d._count._all }))
              .sort((a, b) => b.count - a.count),
          },
          recentComments: comments.map((c) => ({ ...c, userEmail: c.userId ? emailBy.get(c.userId) ?? null : null })),
        },
        lifecycleEmails: (["welcome", "first_cv_nudge", "download_reminder"] as const).map((kind) => ({
          kind,
          sent: lifecycle.find((l) => l.kind === kind && l.status === "sent")?._count._all ?? 0,
          failed: lifecycle.find((l) => l.kind === kind && l.status === "failed")?._count._all ?? 0,
        })),
      },
      error: null,
    });
  });
}
