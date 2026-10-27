import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { isoDate, paged, pageArgs, paginationSchema, parseOr400 } from "./helpers";

// Every piece of feedback people gave (the Feedback table): CV ratings, thumbs
// on AI drafts, and account-deletion reasons (those are stored without a
// user). Read-only, newest first, with the summary numbers for the same filters.

const KINDS = ["cv_rating", "ai_draft", "account_deletion"] as const;

const feedbackQuery = paginationSchema.extend({
  kind: z.enum(KINDS).optional(),
  // cv_rating: 1–5; ai_draft: 1 (up) or -1 (down).
  rating: z.coerce.number().int().min(-1).max(5).optional(),
  withComment: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  // Searches the comment and the user's email.
  q: z.string().trim().max(200).optional(),
  userId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function adminFeedbackRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/feedback", { preHandler: requirePermission("overview:read") }, async (request, reply) => {
    const query = parseOr400(feedbackQuery, request.query, reply);
    if (!query) return;

    // Everything but the kind/rating filters: the summary shows every kind for these filters.
    const base: Prisma.FeedbackWhereInput = {
      ...(query.withComment && { comment: { not: null } }),
      ...(query.userId && { userId: query.userId }),
      ...(query.q && {
        OR: [
          { comment: { contains: query.q, mode: "insensitive" } },
          { user: { email: { contains: query.q, mode: "insensitive" } } },
        ],
      }),
      ...((query.from || query.to) && { createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) } }),
    };
    const where: Prisma.FeedbackWhereInput = {
      ...base,
      ...(query.kind && { kind: query.kind }),
      ...(query.rating !== undefined && { rating: query.rating }),
    };

    const [total, items, byKind, ratingAvg, thumbsUp] = await Promise.all([
      prisma.feedback.count({ where }),
      prisma.feedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...pageArgs(query),
        include: { user: { select: { id: true, email: true, fullName: true } } },
      }),
      prisma.feedback.groupBy({ by: ["kind"], where: base, _count: { _all: true } }),
      prisma.feedback.aggregate({ where: { ...base, kind: "cv_rating" }, _avg: { rating: true } }),
      prisma.feedback.count({ where: { ...base, kind: "ai_draft", rating: 1 } }),
    ]);
    const count = (kind: string) => byKind.find((k) => k.kind === kind)?._count._all ?? 0;

    return reply.send({
      data: {
        ...paged(
          items.map((f) => ({
            id: f.id,
            kind: f.kind,
            rating: f.rating,
            reason: f.reason,
            comment: f.comment,
            flowType: f.flowType,
            cvDocumentId: f.cvDocumentId,
            context: f.context,
            createdAt: f.createdAt,
            user: f.user,
          })),
          total,
          query
        ),
        summary: {
          cvRatings: count("cv_rating"),
          averageRating: ratingAvg._avg.rating === null ? null : Math.round(ratingAvg._avg.rating * 100) / 100,
          aiDrafts: count("ai_draft"),
          thumbsUp,
          deletions: count("account_deletion"),
        },
      },
      error: null,
    });
  });
}
