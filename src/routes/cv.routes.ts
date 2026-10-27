import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { normalizeCvContent } from "../utils/normalize-content";
import { aiRateLimitFor, sendAiRefusal, takeAiCall } from "../middleware/ai-rate-limit.middleware";
import { recordAiUsage, withAiUsageContext } from "../services/ai/usage";
import { trackEvent } from "../services/events.service";
import {
  createCVDocumentSchema,
  generateCVSchema,
  analyzeCVSchema,
  polishSummarySchema,
  moveCVDocumentSchema,
  updateCVContentSchema,
  STEP_ORDER,
  CONTENT_STEP_SCHEMAS,
  type ContentStep,
} from "../schemas/cv.schema";
import {
  validateCVContent,
  isRoleMismatch,
  type AnalyzeResult,
  type RoleMismatch,
} from "../schemas/cv-content.schema";
import { sendError } from "../utils/http-error";
import { renderCVDocumentToPdf } from "../services/render.service";
import { generateCVContent, AIRateLimitedError, AIInvalidOutputError } from "../services/aiGeneration.service";
import { getAIProvider } from "../services/ai";
import {
  assertFeatureAccess,
  chargeStampData,
  consumeGenerationOrThrow,
  createChargeToken,
  isCvLocked,
  lockOf,
  mergeLocks,
  readChargeToken,
  keepChargeToken,
  refundChargeToken,
  refundGeneration,
  FeatureUnavailableError,
  ProFeatureRequiredError,
  ProRequiredError,
  type FlowType,
  type GenerationCharge,
} from "../services/entitlement.service";
import { resolveAccess } from "../services/access.service";
import { ONE_TIME_PRICES } from "../services/polar/plans";
import { getOwnedProfile, ProfileError } from "../services/profile.service";
import { validateGeneratedCv } from "../services/ai/cv/generation/validateGeneratedCv";
import { getProfileDefaults } from "../services/profileDefaults.service";
import { CV_AI_RULE_VERSION } from "../services/ai/cv/rules";
import { isEmptyValue, mergeEmptyFields } from "../utils/merge-content";
import { DEFAULT_CV_TEMPLATE_ID, resolveCVTemplateId } from "../config/cv-templates";
import { SCORE_RULES_VERSION, currentJobAnalysis, scoreDocument, withCurrentScore } from "../services/score/score.service";

const EMPTY_CONTENT = {
  personal: {},
  experience: [],
  education: [],
  skills: [],
  certifications: [],
  projects: [],
  languages: [],
};

// The AI never writes a photo, so a full regeneration would otherwise drop
// the one the user uploaded.
function keepUploadedPhoto(existing: Record<string, unknown>, generated: Record<string, unknown>) {
  const existingPersonal = existing.personal as Record<string, unknown> | undefined;
  if (!existingPersonal?.photo) return generated;
  return { ...generated, personal: { ...(generated.personal as object), photo: existingPersonal.photo } };
}

/** The score fields to store with a save (see services/score). */
function scoreFields(doc: { content: unknown; jobDescription: string | null; jobRequirements: unknown; templateId: string | null }) {
  return { score: scoreDocument(doc).total, scoreVersion: SCORE_RULES_VERSION };
}

/**
 * Creates a recruiter-friendly filename while preserving non-Latin characters
 * for clients that support the RFC 5987 filename* parameter.
 */
function cvFileName(fullName?: string | null): string {
  const parts = (fullName ?? "")
    .split(/\s+/)
    .map((part) => part. replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter(Boolean);
  const base = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return [...base, "Resume"].join("-") + ".pdf";
}

// A free user out of free uses for this flow — logged so the admin can see
// who keeps hitting the limit.
function recordLimitReached(userId: string, flowType: FlowType) {
  void recordAiUsage({ operation: "cv_generation", userId, flowType, status: "limit_reached", errorCode: "PRO_REQUIRED" });
}

// 402 with what the paywall needs: why, and whether "pay at download" is open.
function sendPaywall(reply: FastifyReply, err: ProRequiredError) {
  return reply.code(402).send({
    data: null,
    error: { code: "PRO_REQUIRED", message: err.message, reason: err.reason, flowType: err.flowType, ...err.details },
  });
}

type ChargeableDoc = { id: string; chargedAt: Date | null; unlockProduct: string | null; lockedTier: string | null; unlockedAt: Date | null };
const CHARGE_SELECT = { id: true, chargedAt: true, unlockProduct: true, lockedTier: true, unlockedAt: true } as const;

/** Puts a CV back as it was before a charge stamped it (the AI call failed). */
async function unstampCharge(doc: ChargeableDoc) {
  await prisma.cVDocument.update({
    where: { id: doc.id },
    data: {
      chargedFlow: null,
      chargedAt: null,
      unlockProduct: doc.unlockProduct,
      lockedTier: doc.lockedTier,
      unlockedAt: doc.unlockedAt,
    },
  });
}

// Output that still failed validation after the repair pass. The provider
// calls themselves were logged as successes (their tokens were spent).
function recordInvalidOutput(err: unknown, userId: string, flowType?: string) {
  if (err instanceof AIInvalidOutputError) {
    void recordAiUsage({ operation: "cv_generation", userId, flowType, status: "invalid_output", errorCode: "INVALID_OUTPUT" });
  }
}

/** Ownership + Pro check for linking a CV to a career profile. */
async function resolveLinkableProfile(
  userId: string,
  profileId: string
): Promise<{ version: number } | { error: { status: number; code: string; message: string } }> {
  try {
    await assertFeatureAccess(userId, "careerProfiles");
    const profile = await getOwnedProfile(userId, profileId);
    return { version: profile.version };
  } catch (err) {
    if (err instanceof ProFeatureRequiredError) return { error: { status: 402, code: "PRO_REQUIRED", message: err.message } };
    if (err instanceof FeatureUnavailableError) return { error: { status: 403, code: "FEATURE_UNAVAILABLE", message: err.message } };
    if (err instanceof ProfileError) return { error: { status: err.status, code: err.code, message: err.message } };
    throw err;
  }
}

export async function cvRoutes(app: FastifyInstance) {
  app.post("/api/v1/cv", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createCVDocumentSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const { profileId } = parsed.data;
    const templateId = resolveCVTemplateId(parsed.data.templateId ?? DEFAULT_CV_TEMPLATE_ID);
    if (!templateId) {
      return sendError(reply, 400, "INVALID_TEMPLATE", `Unknown CV template: "${parsed.data.templateId}"`);
    }

    // Linking a CV to a career profile is a Pro feature.
    let profileVersion: number | undefined;
    if (profileId) {
      const linked = await resolveLinkableProfile(request.userId, profileId);
      if ("error" in linked) return sendError(reply, linked.error.status, linked.error.code, linked.error.message);
      profileVersion = linked.version;
    }

    // A copy of a CV that still needs paying for stays locked the same way.
    let inheritedLock = null;
    if (parsed.data.sourceCvId) {
      const source = await prisma.cVDocument.findFirst({
        where: { id: parsed.data.sourceCvId, userId: request.userId },
        select: CHARGE_SELECT,
      });
      inheritedLock = source ? lockOf(source) : null;
    }

    const document = await prisma.cVDocument.create({
      data: {
        userId: request.userId,
        profileId,
        profileVersion,
        templateId,
        title: parsed.data.title,
        content: EMPTY_CONTENT,
        currentStep: "personal",
        ...(inheritedLock ? { unlockProduct: inheritedLock.product, lockedTier: inheritedLock.tier } : {}),
      },
    });

    return reply.code(201).send({ data: document, error: null });
  });

  // profileId is optional — omit it to list every CV document the user owns,
  // linked to a career profile or not.
  app.get("/api/v1/cv", { preHandler: requireAuth }, async (request, reply) => {
    const { profileId } = request.query as { profileId?: string };

    const documents = await prisma.cVDocument.findMany({
      where: profileId ? { profileId, userId: request.userId } : { userId: request.userId },
      orderBy: { updatedAt: "desc" },
    });

    return reply.send({ data: documents.map(withCurrentScore), error: null });
  });

  app.get("/api/v1/cv/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    return reply.send({ data: withCurrentScore(document), error: null });
  });

  app.patch("/api/v1/cv/:id/step/:stepName", { preHandler: requireAuth }, async (request, reply) => {
    const { id, stepName } = request.params as { id: string; stepName: string };

    if (!(STEP_ORDER as readonly string[]).includes(stepName) || stepName === "review") {
      return sendError(reply, 400, "INVALID_STEP", `Unknown or unsupported wizard step: ${stepName}`);
    }

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    const sectionSchema = CONTENT_STEP_SCHEMAS[stepName as ContentStep];
    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed = sectionSchema.safeParse(body[stepName]);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid section data");
    }

    const existingContent = (document.content ?? {}) as Record<string, unknown>;
    const updatedContent = { ...existingContent, [stepName]: parsed.data };

    const stepIndex = STEP_ORDER.indexOf(stepName as (typeof STEP_ORDER)[number]);
    const nextStep =
      document.currentStep === stepName && stepIndex < STEP_ORDER.length - 1
        ? STEP_ORDER[stepIndex + 1]
        : document.currentStep;

    const updated = await prisma.cVDocument.update({
      where: { id },
      data: {
        content: updatedContent as Prisma.InputJsonValue,
        currentStep: nextStep,
        ...scoreFields({ ...document, content: updatedContent }),
      },
    });

    return reply.send({ data: updated, error: null });
  });

  app.post("/api/v1/cv/:id/finalize", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    const content = normalizeCvContent((document.content ?? {}) as Record<string, unknown>);

    // A CV can be exported once it has the essentials — a name, a valid email,
    // at least one job and one skill (the same list the editor checks before
    // calling this). Everything else is optional: an education entry without
    // a degree, a job without dates or a missing headline just renders
    // without them rather than blocking the download.
    const personal = (content.personal ?? {}) as { full_name?: unknown; email?: unknown };
    const missing: { field: string; label: string }[] = [];
    if (typeof personal.full_name !== "string" || !personal.full_name.trim()) {
      missing.push({ field: "personal.full_name", label: "your full name" });
    }
    if (typeof personal.email !== "string" || !z.string().email().safeParse(personal.email.trim()).success) {
      missing.push({ field: "personal.email", label: "a valid email address" });
    }
    if (!Array.isArray(content.experience) || content.experience.length === 0) {
      missing.push({ field: "experience", label: "at least one experience entry" });
    }
    if (!Array.isArray(content.skills) || content.skills.length === 0) {
      missing.push({ field: "skills", label: "at least one skill" });
    }

    if (missing.length > 0) {
      return reply.code(422).send({
        data: null,
        error: {
          code: "INCOMPLETE_DOCUMENT",
          message: `Add ${missing.map((m) => m.label).join(", ")} before downloading.`,
          fields: missing.map((m) => m.field),
        },
      });
    }

    // Still reject malformed data (e.g. a corrupt photo) — the lenient schema
    // checks types and formats without requiring every field.
    const shape = validateCVContent(content, { partial: true });
    if (!shape.success) {
      const issue = shape.error.issues[0];
      return sendError(reply, 422, "INVALID_DOCUMENT", issue?.message ?? "This CV has data we can't export");
    }

    const updated = await prisma.cVDocument.update({
      where: { id },
      data: { status: "final" },
    });

    return reply.send({ data: updated, error: null });
  });

  // Stateless — runs the same combined AI analysis (structuring + tailoring +
  // job compatibility + clarification questions) as /cv/:id/generate but
  // never persists anything. Lets the frontend show clarification questions
  // and job-compatibility gaps before committing to a CV document at all.
  app.post("/api/v1/cv/analyze", { preHandler: [requireAuth, aiRateLimitFor("cv_generation")] }, async (request, reply) => {
    const parsed = analyzeCVSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const templateId = resolveCVTemplateId(parsed.data.templateId) ?? DEFAULT_CV_TEMPLATE_ID;

    // Each CV is charged once. A brand-new flow is charged here, before its
    // CV exists — the charge travels to the save in chargeToken. A call on an
    // existing CV is free when that CV is already charged; one that isn't yet
    // (copied from a saved resume or profile) is charged now.
    const { payLater, sourceCvId, sourceProfileId, cvDocumentId, ...aiInput } = parsed.data;
    let charge: GenerationCharge | undefined;
    let chargeToken: string | undefined;
    let stamped: ChargeableDoc | null = null;
    try {
      if (cvDocumentId) {
        const doc = await prisma.cVDocument.findFirst({
          where: { id: cvDocumentId, userId: request.userId },
          select: CHARGE_SELECT,
        });
        if (!doc) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
        if (!doc.chargedAt) {
          if (!parsed.data.flowType) {
            return sendError(reply, 400, "VALIDATION_ERROR", "flowType is required to start a new CV flow");
          }
          charge = await consumeGenerationOrThrow(request.userId, parsed.data.flowType, { payLater, fromExisting: true });
          await prisma.cVDocument.update({ where: { id: doc.id }, data: chargeStampData(charge, lockOf(doc)) });
          stamped = doc;
        }
      } else {
        if (!parsed.data.flowType) {
          return sendError(reply, 400, "VALIDATION_ERROR", "flowType is required to start a new CV flow");
        }
        // Reworking a saved resume or profile of theirs: priced as tailored /
        // improved, and the resume's own unpaid lock carries over.
        let fromExisting = false;
        let sourceLock = null;
        if (sourceCvId) {
          const source = await prisma.cVDocument.findFirst({
            where: { id: sourceCvId, userId: request.userId },
            select: CHARGE_SELECT,
          });
          if (source) {
            fromExisting = true;
            sourceLock = lockOf(source);
          }
        } else if (sourceProfileId) {
          fromExisting = Boolean(
            await prisma.careerProfile.findFirst({ where: { id: sourceProfileId, userId: request.userId }, select: { id: true } })
          );
        }
        charge = await consumeGenerationOrThrow(request.userId, parsed.data.flowType, { payLater, fromExisting });
        chargeToken = createChargeToken(request.userId, { ...charge, lock: mergeLocks(sourceLock, charge.lock) });
      }
    } catch (err) {
      if (err instanceof ProRequiredError) {
        recordLimitReached(request.userId, err.flowType);
        return sendPaywall(reply, err);
      }
      throw err;
    }
    // Gives back the charge when the AI produced nothing usable.
    const undoCharge = async () => {
      await refundGeneration(request.userId, charge);
      if (stamped) await unstampCharge(stamped);
    };

    let result: AnalyzeResult | RoleMismatch;
    const profileDefaults = await getProfileDefaults(request.userId);
    try {
      result = await withAiUsageContext({ userId: request.userId, flowType: parsed.data.flowType }, () =>
        generateCVContent({ ...aiInput, templateId, profileDefaults })
      );
    } catch (err) {
      await undoCharge();
      recordInvalidOutput(err, request.userId, parsed.data.flowType);
      if (err instanceof AIRateLimitedError) {
        request.log.warn({ err }, "AI CV analysis rate-limited");
        return sendError(
          reply,
          429,
          "AI_RATE_LIMITED",
          "The AI service is busy right now. Please wait a moment and try again."
        );
      }
      request.log.error({ err }, "AI CV analysis failed");
      return sendError(reply, 502, "AI_GENERATION_FAILED", "AI analysis failed. Please try again.");
    }

    if (isRoleMismatch(result)) {
      await undoCharge();
      return reply.send({ data: { mismatch: true, reason: result.reason, missing: result.missing }, error: null });
    }

    // The save (POST /cv/:id/generate) runs this same check before persisting.
    // A result it would turn away is never charged: the user hasn't got a CV.
    const identity = aiInput.name || aiInput.email ? { name: aiInput.name, email: aiInput.email } : undefined;
    const saveCheck = validateGeneratedCv(result.candidateData, { templateId, userIdentity: identity, profileDefaults });
    if (!saveCheck.success) {
      await undoCharge();
      recordInvalidOutput(new AIInvalidOutputError(saveCheck.error.issues.map((i) => i.message).join("; ")), request.userId, parsed.data.flowType);
      request.log.error({ issues: saveCheck.error.issues }, "AI CV analysis produced content the save would reject");
      return sendError(reply, 502, "AI_GENERATION_FAILED", "AI analysis failed. Please try again.");
    }

    // `billing` tells the flow when this CV will need paying for at download.
    const lock = charge?.lock ?? null;
    return reply.send({
      data: {
        ...result,
        chargeToken,
        billing: charge ? { kind: charge.kind, lock: lock ? { ...lock, price: ONE_TIME_PRICES[lock.product] } : null } : null,
      },
      error: null,
    });
  });

  // Stateless, narrow rewrite of just the summary field — see
  // openai-compatible.provider.ts#polishSummary. Never persists; the editor decides
  // whether to accept the result into its local draft.
  app.post("/api/v1/cv/polish-summary", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = polishSummarySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    try {
      await assertFeatureAccess(request.userId, "polishSummary");
    } catch (err) {
      if (err instanceof ProFeatureRequiredError) return sendError(reply, 402, "PRO_REQUIRED", err.message);
      if (err instanceof FeatureUnavailableError) return sendError(reply, 403, "FEATURE_UNAVAILABLE", err.message);
      throw err;
    }

    const aiCall = await takeAiCall(request.userId, "polish_summary");
    if (!aiCall.ok) return sendAiRefusal(reply, aiCall);

    try {
      const summary = await withAiUsageContext({ userId: request.userId }, () => getAIProvider().polishSummary(parsed.data));
      return reply.send({ data: { summary }, error: null });
    } catch (err) {
      request.log.error({ err }, "AI summary polish failed");
      return sendError(reply, 502, "SUMMARY_POLISH_FAILED", "Could not polish this summary right now.");
    }
  });

  app.post("/api/v1/cv/:id/generate", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = generateCVSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    const userIdentity = { name: parsed.data.name, email: parsed.data.email };
    const profileDefaults = await getProfileDefaults(request.userId);

    let result: AnalyzeResult | RoleMismatch;
    // Stays undefined on the analyzedContent path (no AI call there).
    let charge: GenerationCharge | undefined;
    // The charge this save writes onto a CV not charged yet (see POST /cv/analyze).
    let chargeStamp: ReturnType<typeof chargeStampData> | null = null;
    if (parsed.data.analyzedContent) {
      // Already analyzed (via POST /cv/analyze) — skip the AI call entirely.
      // AI content can only land in an uncharged CV with the charge that paid for it.
      if (!document.chargedAt) {
        const carried = parsed.data.chargeToken ? readChargeToken(parsed.data.chargeToken, request.userId) : null;
        if (!carried) {
          return sendError(reply, 400, "CHARGE_TOKEN_REQUIRED", "Start a new CV flow to generate this CV.");
        }
        chargeStamp = chargeStampData(carried, lockOf(document));
      }
      result = { candidateData: parsed.data.analyzedContent, questions: [], jobAnalysis: null };
    } else {
      // Only this branch performs a real AI call (the other branch reuses
      // an already-analyzed result from POST /cv/analyze, which was already
      // gated there) — so the free-generation spend belongs here, not above.
      const aiCall = await takeAiCall(request.userId, "cv_generation");
      if (!aiCall.ok) return sendAiRefusal(reply, aiCall);

      if (!parsed.data.flowType) {
        return sendError(reply, 400, "VALIDATION_ERROR", "flowType is required to start a new CV flow");
      }
      const flowType = parsed.data.flowType;

      // Charged once per CV: free when this CV is already paid for.
      if (!document.chargedAt) {
        try {
          charge = await consumeGenerationOrThrow(request.userId, flowType, { payLater: parsed.data.payLater });
        } catch (err) {
          if (err instanceof ProRequiredError) {
            recordLimitReached(request.userId, flowType);
            return sendPaywall(reply, err);
          }
          throw err;
        }
        chargeStamp = chargeStampData(charge, lockOf(document));
      }

      // Carry forward the skills on this CV's career profile, so a new CV for
      // the same role doesn't lose skills the profile already records.
      let knownSkills: string[] | undefined;
      if (document.profileId) {
        const profile = await getOwnedProfile(request.userId, document.profileId).catch(() => null);
        const skills = profile?.content.skills.map((skill) => skill.name) ?? [];
        if (skills.length > 0) knownSkills = skills;
      }

      try {
        result = await withAiUsageContext({ userId: request.userId, flowType }, () =>
          generateCVContent({
            ...parsed.data,
            sourceText: parsed.data.sourceText as string,
            templateId: document.templateId,
            knownSkills,
            profileDefaults,
          })
        );
      } catch (err) {
        await refundGeneration(request.userId, charge);
        recordInvalidOutput(err, request.userId, flowType);
        if (err instanceof AIRateLimitedError) {
          request.log.warn({ err }, "AI CV generation rate-limited");
          return sendError(
            reply,
            429,
            "AI_RATE_LIMITED",
            "The AI service is busy right now. Please wait a moment and try again."
          );
        }
        request.log.error({ err }, "AI CV generation failed");
        return sendError(reply, 502, "AI_GENERATION_FAILED", "AI generation failed. Please try again.");
      }
    }

    if (isRoleMismatch(result)) {
      await refundGeneration(request.userId, charge);
      request.log.info(
        { cvDocumentId: id, reason: result.reason },
        "AI CV generation declined: job description is an unrelated role"
      );
      return reply.send({ data: { mismatch: true, reason: result.reason, missing: result.missing }, error: null });
    }

    // Final gate before anything is persisted: re-applies the template's allowed
    // optional sections and the authoritative name/email, then validates shape
    // (stricter than analysis — requires >=1 experience entry and >=1 skill).
    const validation = validateGeneratedCv(result.candidateData, {
      templateId: document.templateId,
      userIdentity,
      profileDefaults,
    });
    if (!validation.success) {
      await refundGeneration(request.userId, charge);
      // Content analyzed (and paid for) by POST /cv/analyze that can't be saved: give that charge back too.
      if (parsed.data.analyzedContent && parsed.data.chargeToken) {
        await refundChargeToken(parsed.data.chargeToken, request.userId);
      }
      request.log.error({ issues: validation.error.issues }, "AI generated content failed schema validation");
      return sendError(
        reply,
        502,
        "AI_GENERATION_FAILED",
        "AI returned content that did not match the expected shape"
      );
    }

    const existingContent = (document.content ?? {}) as Record<string, unknown>;
    const wasEmpty = document.currentStep === "personal" && Object.values(existingContent).every(isEmptyValue);
    const mergedContent = parsed.data.replaceContent
      ? keepUploadedPhoto(existingContent, validation.data as Record<string, unknown>)
      : mergeEmptyFields(existingContent, validation.data as Record<string, unknown>);

    const content = normalizeCvContent(mergedContent);
    const jobDescription = parsed.data.jobDescription ?? null;
    // A different job description makes the stored job analysis stale.
    const jobRequirements = currentJobAnalysis(jobDescription, document.jobRequirements);
    const updated = await prisma.cVDocument.update({
      where: { id },
      data: {
        content: content as Prisma.InputJsonValue,
        source: "ai",
        ...(chargeStamp ?? {}),
        currentStep: wasEmpty ? "review" : document.currentStep,
        jobDescription,
        jobRequirements: jobRequirements ? (jobRequirements as Prisma.InputJsonValue) : Prisma.DbNull,
        ...scoreFields({ content, jobDescription, jobRequirements, templateId: document.templateId }),
      },
    });

    // The user has their CV now: the analysis's charge stays spent.
    if (parsed.data.chargeToken) keepChargeToken(parsed.data.chargeToken, request.userId);

    request.log.info(
      { cvDocumentId: id, ruleVersion: CV_AI_RULE_VERSION, enhancementLevel: parsed.data.enhancementLevel },
      "AI CV generation succeeded"
    );
    trackEvent("cv_generated", request.userId, {
      flowType: parsed.data.flowType ?? null,
      withJobDescription: Boolean(parsed.data.jobDescription),
      templateId: document.templateId,
    });

    return reply.send({
      data: { ...updated, questions: result.questions, jobAnalysis: result.jobAnalysis },
      error: null,
    });
  });

  // Persists edits made in the free-form CV editor ("Done" action). Unlike
  // the per-step wizard endpoint, this accepts a partial content object and
  // shallow-merges it into whatever sections are provided — the editor lets
  // a user leave other sections untouched or incomplete.
  app.patch("/api/v1/cv/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = updateCVContentSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    const templateId = parsed.data.templateId ? resolveCVTemplateId(parsed.data.templateId) : undefined;
    if (templateId === null) {
      return sendError(reply, 400, "INVALID_TEMPLATE", `Unknown CV template: "${parsed.data.templateId}"`);
    }

    const data: Prisma.CVDocumentUpdateInput = {};
    if (parsed.data.content) {
      const existingContent = (document.content ?? {}) as Record<string, unknown>;
      data.content = normalizeCvContent({ ...existingContent, ...parsed.data.content }) as Prisma.InputJsonValue;
    }
    if (templateId) {
      data.templateId = templateId;
    }
    if (parsed.data.jobDescription !== undefined) {
      data.jobDescription = parsed.data.jobDescription;
    }
    if (parsed.data.title !== undefined) {
      data.title = parsed.data.title;
    }

    // Rescore on every save. A changed job description drops the stored job
    // analysis (it was made from the old text); the editor asks for a new one.
    const jobDescription = parsed.data.jobDescription !== undefined ? parsed.data.jobDescription : document.jobDescription;
    const jobRequirements = currentJobAnalysis(jobDescription, document.jobRequirements);
    if (!jobRequirements && document.jobRequirements !== null) data.jobRequirements = Prisma.DbNull;
    Object.assign(data, scoreFields({ content: data.content ?? document.content, jobDescription, jobRequirements, templateId: templateId ?? document.templateId }));

    const updated = await prisma.cVDocument.update({ where: { id }, data });

    return reply.send({ data: updated, error: null });
  });

  // Reassigns a CV document to a different career profile owned by the same
  // user, or detaches it entirely (profileId: null) — used both when a
  // document is generated before the user decides where it belongs, and to
  // explicitly move/detach an existing CV.
  app.patch("/api/v1/cv/:id/profile", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = moveCVDocumentSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    // Attaching needs Pro; detaching (null) is always allowed.
    let link: { profileId: string | null; profileVersion: number | null } = { profileId: null, profileVersion: null };
    if (parsed.data.profileId) {
      const linked = await resolveLinkableProfile(request.userId, parsed.data.profileId);
      if ("error" in linked) return sendError(reply, linked.error.status, linked.error.code, linked.error.message);
      link = { profileId: parsed.data.profileId, profileVersion: linked.version };
    }

    const updated = await prisma.cVDocument.update({
      where: { id },
      data: link,
    });

    return reply.send({ data: updated, error: null });
  });

  // Renders the finalized document to PDF on demand and streams it back —
  // nothing is written to disk, so this works on ephemeral/multi-instance
  // hosts and always reflects the latest edits.
  app.get("/api/v1/cv/:id/download", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }
    if (document.status !== "final") {
      return sendError(reply, 400, "DOCUMENT_NOT_FINAL", "Finalize the document before downloading it as a PDF");
    }
    // Pay-per-CV: made past the free CV (or a Plus limit) — paid for at download.
    const access = await resolveAccess(request.userId);
    if (isCvLocked(document, access?.tier ?? "free")) {
      const product = document.unlockProduct === "cv_edit" ? "cv_edit" : "cv_new";
      return reply.code(402).send({
        data: null,
        error: {
          code: "CV_PAYMENT_REQUIRED",
          message: "Unlock this CV to download it, or upgrade to download every CV.",
          cvDocumentId: document.id,
          product,
          price: ONE_TIME_PRICES[product],
        },
      });
    }

    const pdfBuffer = await renderCVDocumentToPdf(document.content, document.templateId);
    trackEvent("pdf_downloaded", request.userId, { templateId: document.templateId, aiMade: document.source === "ai" });

    reply.header("Content-Type", "application/pdf");
    const fullName = (document.content as { personal?: { full_name?: string } } | null)?.personal?.full_name;
    const fileName = cvFileName(fullName);
    // ASCII fallback for old clients; filename* carries non-Latin names intact.
    const asciiName = fileName
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/"/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+/, "");
    reply.header(
      "Content-Disposition",
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    return reply.send(pdfBuffer);
  });

  app.delete("/api/v1/cv/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    await prisma.cVDocument.delete({ where: { id } });

    return reply.send({ data: { success: true }, error: null });
  });
}
