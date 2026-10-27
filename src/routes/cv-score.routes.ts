import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendAiRefusal, takeAiCall } from "../middleware/ai-rate-limit.middleware";
import { withAiUsageContext } from "../services/ai/usage";
import { getAIProvider } from "../services/ai";
import { assertFeatureAccess, FeatureUnavailableError, ProFeatureRequiredError } from "../services/entitlement.service";
import { jobAnalysisRequestSchema, polishCvSchema, reviewCvSchema } from "../schemas/cv.schema";
import { normalizeCvContent } from "../utils/normalize-content";
import { sendError } from "../utils/http-error";
import {
  SCORE_RULES_VERSION,
  allPolishTargets,
  applyPolishPatch,
  buildPolishInput,
  currentJobAnalysis,
  cvPlainText,
  failingIssues,
  hashJobDescription,
  isEmptyJobAnalysis,
  jobRequirementsFor,
  sanitizePolish,
  scoreContent,
  type StoredJobAnalysis,
} from "../services/score/score.service";

/**
 * CV score endpoints. The score itself is deterministic (services/score/engine.ts)
 * and computed on every save in cv.routes.ts; these are the AI parts around it:
 * - job-analysis: the job description's requirements, extracted once per job description and stored;
 * - review: written tips ("AI check") that never change the score;
 * - polish (Pro): rewrites that fix failing checks, returned for the editor to apply.
 */
export async function cvScoreRoutes(app: FastifyInstance) {
  app.post("/api/v1/cv/:id/job-analysis", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = jobAnalysisRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    let document = await prisma.cVDocument.findFirst({ where: { id, userId: request.userId } });
    if (!document) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");

    // The editor may send a job description it hasn't autosaved yet.
    if (parsed.data.jobDescription !== undefined && parsed.data.jobDescription !== document.jobDescription) {
      document = await prisma.cVDocument.update({
        where: { id },
        data: { jobDescription: parsed.data.jobDescription || null, jobRequirements: Prisma.DbNull },
      });
    }

    const jobDescription = document.jobDescription?.trim();
    if (!jobDescription) return sendError(reply, 400, "NO_JOB_DESCRIPTION", "This CV has no job description to analyze.");

    let analysis: StoredJobAnalysis | null = currentJobAnalysis(jobDescription, document.jobRequirements);
    if (!analysis) {
      const aiCall = await takeAiCall(request.userId, "jd_analysis");
      if (!aiCall.ok) return sendAiRefusal(reply, aiCall);
      try {
        const data = await withAiUsageContext({ userId: request.userId }, () => getAIProvider().analyzeJobDescription(jobDescription));
        analysis = { jdHash: hashJobDescription(jobDescription), data: isEmptyJobAnalysis(data) ? null : data };
      } catch (err) {
        request.log.error({ err }, "Job description analysis failed");
        return sendError(reply, 502, "JOB_ANALYSIS_FAILED", "Could not read this job description right now. Please try again.");
      }
    }

    const score = scoreContent(document.content, analysis.data, document.templateId);
    const updated = await prisma.cVDocument.update({
      where: { id },
      data: { jobRequirements: analysis as Prisma.InputJsonValue, score: score.total, scoreVersion: SCORE_RULES_VERSION },
    });

    return reply.send({ data: { jobRequirements: updated.jobRequirements, score: score.total, scoreVersion: SCORE_RULES_VERSION }, error: null });
  });

  app.post("/api/v1/cv/:id/review", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = reviewCvSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const document = await prisma.cVDocument.findFirst({ where: { id, userId: request.userId } });
    if (!document) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");

    const content = normalizeCvContent((parsed.data.content ?? document.content ?? {}) as Record<string, unknown>);
    const cvText = cvPlainText(content);
    if (!cvText) return sendError(reply, 400, "CV_EMPTY", "Add some content to your CV first.");

    const job = jobRequirementsFor(document.jobDescription, document.jobRequirements);
    const score = scoreContent(content, job, document.templateId);

    const aiCall = await takeAiCall(request.userId, "cv_review");
    if (!aiCall.ok) return sendAiRefusal(reply, aiCall);

    try {
      const tips = await withAiUsageContext({ userId: request.userId }, () =>
        getAIProvider().reviewCv({ cvText, job: job ?? undefined, issues: failingIssues(score) })
      );
      return reply.send({ data: { tips }, error: null });
    } catch (err) {
      request.log.error({ err }, "AI CV review failed");
      return sendError(reply, 502, "CV_REVIEW_FAILED", "Could not review this CV right now. Please try again.");
    }
  });

  app.post("/api/v1/cv/:id/polish", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = polishCvSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    try {
      await assertFeatureAccess(request.userId, "aiPolish");
    } catch (err) {
      if (err instanceof ProFeatureRequiredError) return sendError(reply, 402, "PRO_REQUIRED", err.message);
      if (err instanceof FeatureUnavailableError) return sendError(reply, 403, "FEATURE_UNAVAILABLE", err.message);
      throw err;
    }

    const document = await prisma.cVDocument.findFirst({ where: { id, userId: request.userId } });
    if (!document) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");

    const content = normalizeCvContent((parsed.data.content ?? document.content ?? {}) as Record<string, unknown>);
    const job = jobRequirementsFor(document.jobDescription, document.jobRequirements);
    const before = scoreContent(content, job, document.templateId);
    const targets = parsed.data.targets === "all" ? allPolishTargets(before) : parsed.data.targets;
    // A headline is only rewritten toward a job; without one there's nothing to aim at.
    const usable = targets.filter((t) => t.kind !== "headline" || job);

    const input = buildPolishInput(content, usable, before, job);
    const hasWork = input.summary !== undefined || input.headline !== undefined || input.skills !== undefined || (input.roles?.length ?? 0) > 0;
    if (!hasWork || !input.cvText) {
      return sendError(reply, 400, "NOTHING_TO_POLISH", "There's nothing AI can improve here yet. Fill in the highlighted details first.");
    }

    const aiCall = await takeAiCall(request.userId, "cv_polish");
    if (!aiCall.ok) return sendAiRefusal(reply, aiCall);

    try {
      const result = await withAiUsageContext({ userId: request.userId }, () => getAIProvider().polishCv(input));
      const patch = sanitizePolish(content, input, result);
      const after = scoreContent(applyPolishPatch(content, patch), job, document.templateId);
      return reply.send({ data: { patch, score: before.total, projectedScore: after.total }, error: null });
    } catch (err) {
      request.log.error({ err }, "AI CV polish failed");
      return sendError(reply, 502, "CV_POLISH_FAILED", "Could not polish this CV right now. Please try again.");
    }
  });
}
