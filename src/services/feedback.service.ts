import { z } from "zod";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "../db/client";
import { hasBillingPro } from "./access.service";

// What people tell us about the product (the Feedback table):
//   cv_rating        — "How did your CV turn out?" 1–5, after the first CV (leaving
//                      the editor) or a download, until they've rated once
//   ai_draft         — thumbs up (1) / down (-1) on a CV a flow just wrote
//   account_deletion — why they left; stored without the user
// One cv_rating / ai_draft per user per CV: answering again replaces it.

export const AI_DRAFT_REASONS = ["wrong_details", "too_generic", "missing_experience", "bad_wording", "too_long", "other"] as const;

const comment = z.string().trim().max(1000).optional();

export const feedbackSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cv_rating"),
    rating: z.number().int().min(1).max(5),
    comment,
    cvDocumentId: z.string().uuid().optional(),
    // Which moment asked: leaving the editor, or right after a download.
    trigger: z.enum(["editor_exit", "download"]).optional(),
  }),
  z.object({
    kind: z.literal("ai_draft"),
    rating: z.union([z.literal(1), z.literal(-1)]),
    reason: z.enum(AI_DRAFT_REASONS).optional(),
    comment,
    cvDocumentId: z.string().uuid(),
    flowType: z.enum(["create", "tailor", "improve"]).optional(),
  }),
]);
export type FeedbackInput = z.infer<typeof feedbackSchema>;

export class FeedbackCvNotFoundError extends Error {}

export async function recordFeedback(userId: string, input: FeedbackInput) {
  if (input.cvDocumentId) {
    const owned = await prisma.cVDocument.findFirst({ where: { id: input.cvDocumentId, userId }, select: { id: true } });
    if (!owned) throw new FeedbackCvNotFoundError("CV document not found");
  }

  const data = {
    userId,
    kind: input.kind,
    rating: input.rating,
    reason: input.kind === "ai_draft" ? (input.reason ?? null) : null,
    comment: input.comment || null,
    cvDocumentId: input.cvDocumentId ?? null,
    flowType: input.kind === "ai_draft" ? (input.flowType ?? null) : null,
    context:
      input.kind === "cv_rating" && input.trigger ? ({ trigger: input.trigger } as Prisma.InputJsonValue) : undefined,
  };

  // Answering again (changing a thumb, adding a comment) replaces the earlier answer.
  const existing = await prisma.feedback.findFirst({
    where: { userId, kind: input.kind, cvDocumentId: input.cvDocumentId ?? null },
    select: { id: true },
  });
  return existing
    ? prisma.feedback.update({ where: { id: existing.id }, data })
    : prisma.feedback.create({ data });
}

/**
 * The reason someone gave for deleting their account. Kept with no link to
 * them — only how long they'd had the account, how many CVs they made and
 * whether they were paying. Never fails the deletion.
 */
export async function recordDeletionFeedback(
  user: User,
  input: { reason?: string; comment?: string }
): Promise<void> {
  try {
    const cvCount = await prisma.cVDocument.count({ where: { userId: user.id } });
    const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    await prisma.feedback.create({
      data: {
        userId: null,
        kind: "account_deletion",
        reason: input.reason ?? null,
        comment: input.comment || null,
        context: { accountAgeDays, cvCount, wasPaying: hasBillingPro(user, new Date()) } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn("[feedback] failed to record deletion reason", err instanceof Error ? err.message : err);
  }
}
