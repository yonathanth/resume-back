import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { DEFAULT_CV_TEMPLATE_ID, isValidCVTemplateId, resolveCVTemplateId } from "../config/cv-templates";
import { PartialCVContent, isRoleMismatch } from "../schemas/cv-content.schema";
import { AIRateLimitedError, generateCVContent } from "../services/aiGeneration.service";
import { withAiUsageContext } from "../services/ai/usage";
import { validateGeneratedCv } from "../services/ai/cv/generation/validateGeneratedCv";
import { runImportExtraction, type ImportFileType } from "../services/importExtraction.service";
import { renderCVDocumentToPdf, renderCvHtml } from "../services/render.service";
import { sendError } from "../utils/http-error";
import { getAIProvider } from "../services/ai";
import { polishCvSchema } from "../schemas/cv.schema";
import { normalizeCvContent } from "../utils/normalize-content";
import { allPolishTargets, applyPolishPatch, buildPolishInput, cvPlainText, failingIssues, isEmptyJobAnalysis, sanitizePolish, scoreContent } from "../services/score/score.service";

/**
 * The CV engine for partner apps (Ethio Jobs): generate, import, preview and
 * PDF — stateless. Partners own their users, saved CVs and billing, so these
 * routes never touch GoMoxie accounts, charges or CV documents. Auth: the
 * `x-partner-key` header must match one of PARTNER_API_KEYS ("name:secret").
 * AI usage is still logged (flowType "partner:<name>:<flow>", no userId).
 */

/** name → secret. Pure, unit-tested. */
export function parsePartnerKeys(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i > 0 && pair.length - i > 16) out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return out;
}

/** The partner whose secret matches, compared in constant time; null if none. */
export function partnerFor(key: string | undefined, keys: Map<string, string>): string | null {
  if (!key) return null;
  const given = Buffer.from(key);
  for (const [name, secret] of keys) {
    const expected = Buffer.from(secret);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return name;
  }
  return null;
}

const PARTNER_KEYS = parsePartnerKeys(env.PARTNER_API_KEYS);

type PartnerRequest = FastifyRequest & { partner?: string };

async function requirePartner(request: PartnerRequest, reply: FastifyReply) {
  const header = request.headers["x-partner-key"];
  const partner = partnerFor(Array.isArray(header) ? header[0] : header, PARTNER_KEYS);
  if (!partner) return sendError(reply, 401, "PARTNER_UNAUTHORIZED", "Missing or invalid partner key");
  request.partner = partner;
}

const generateSchema = z.object({
  flowType: z.enum(["create", "improve", "tailor"]),
  /** Everything known about the person: typed answers, an imported CV's text, or a base CV as text. */
  sourceText: z.string().min(20).max(30_000),
  /** Tailoring: the job post. */
  jobDescription: z.string().max(20_000).optional(),
  templateId: z.string().optional(),
  enhancementLevel: z.number().min(0).max(1).optional(),
  name: z.string().max(120).optional(),
  email: z.string().max(200).optional(),
  focusInstructions: z.string().max(1_000).optional(),
});

const renderSchema = z.object({
  templateId: z.string().min(1),
  content: PartialCVContent,
  watermark: z.boolean().optional(),
});

const EXT_TO_FILE_TYPE: Record<string, ImportFileType> = { ".pdf": "pdf", ".docx": "docx", ".png": "image", ".jpg": "image", ".jpeg": "image" };

export async function partnerRoutes(app: FastifyInstance) {
  // Turns what the person provided into a full CV (same AI and rules as GoMoxie's own flows).
  app.post("/api/v1/partner/cv/generate", { preHandler: requirePartner }, async (request: PartnerRequest, reply) => {
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    const { flowType, ...input } = parsed.data;
    if (flowType === "tailor" && !input.jobDescription) return sendError(reply, 400, "VALIDATION_ERROR", "jobDescription is required to tailor");
    const templateId = resolveCVTemplateId(input.templateId) ?? DEFAULT_CV_TEMPLATE_ID;
    try {
      const result = await withAiUsageContext({ flowType: `partner:${request.partner}:${flowType}` }, () =>
        generateCVContent({ ...input, templateId }),
      );
      if (isRoleMismatch(result)) return reply.send({ data: { mismatch: true, reason: result.reason, missing: result.missing }, error: null });
      const identity = input.name || input.email ? { name: input.name, email: input.email } : undefined;
      const check = validateGeneratedCv(result.candidateData, { templateId, userIdentity: identity });
      if (!check.success) return sendError(reply, 502, "AI_GENERATION_FAILED", "The CV couldn't be generated. Please try again.");
      return reply.send({ data: { mismatch: false, ...result, templateId }, error: null });
    } catch (err) {
      if (err instanceof AIRateLimitedError) return sendError(reply, 429, "AI_RATE_LIMITED", "The AI service is busy right now. Please try again in a moment.");
      request.log.error({ err, partner: request.partner, flowType }, "partner CV generation failed");
      return sendError(reply, 502, "AI_GENERATION_FAILED", "The CV couldn't be generated. Please try again.");
    }
  });

  // An uploaded CV (pdf, docx, photo) → its text, for the "improve my CV" flow. Nothing is stored.
  app.post("/api/v1/partner/import", { preHandler: requirePartner }, async (request, reply) => {
    const file = await request.file();
    if (!file) return sendError(reply, 400, "NO_FILE", "No file was uploaded");
    const fileType = EXT_TO_FILE_TYPE[path.extname(file.filename).toLowerCase()];
    if (!fileType) return sendError(reply, 400, "UNSUPPORTED_FILE_TYPE", "Accepted file types: pdf, docx, png, jpg, jpeg");
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return sendError(reply, 413, "FILE_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_MB}MB upload limit`);
    }
    try {
      const { rawText, extractedData } = await runImportExtraction(buffer, fileType);
      return reply.send({ data: { rawText, extractedData }, error: null });
    } catch (err) {
      request.log.warn({ err }, "partner import extraction failed");
      return sendError(reply, 422, "EXTRACTION_FAILED", "We couldn't read that file. Try a clearer photo or a PDF.");
    }
  });

  // Live preview HTML (the exact template the PDF uses).
  app.post("/api/v1/partner/cv/preview", { preHandler: requirePartner }, async (request, reply) => {
    const parsed = renderSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    if (!isValidCVTemplateId(parsed.data.templateId)) return sendError(reply, 400, "INVALID_TEMPLATE", "Unknown CV template");
    const html = await renderCvHtml(parsed.data.content, parsed.data.templateId, {
      mode: "preview",
      fontBaseUrl: `${request.protocol}://${request.host}/api/v1/templates/fonts`,
    });
    return reply.send({ data: { html }, error: null });
  });

  // The PDF. The partner decides about the watermark (unpaid CVs).
  app.post("/api/v1/partner/cv/pdf", { preHandler: requirePartner }, async (request, reply) => {
    const parsed = renderSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    if (!isValidCVTemplateId(parsed.data.templateId)) return sendError(reply, 400, "INVALID_TEMPLATE", "Unknown CV template");
    const pdf = await renderCVDocumentToPdf(parsed.data.content, parsed.data.templateId, { watermark: parsed.data.watermark ?? false });
    reply.header("Content-Type", "application/pdf");
    reply.header("Cache-Control", "no-store");
    return reply.send(pdf);
  });
}

// ── Score helpers: the same AI steps GoMoxie's editor uses (services/score). ──

const jobSchema = z.object({ jobDescription: z.string().min(40).max(20_000) });

const requirementsSchema = z.object({
  title: z.string(),
  seniority: z.string().default(""),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
  keywords: z.array(z.string()).default([]),
});

const polishSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  templateId: z.string().optional(),
  targets: z.union([z.literal("all"), polishCvSchema.shape.targets]),
  jobRequirements: requirementsSchema.nullable().optional(),
});

const reviewSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  templateId: z.string().optional(),
  jobRequirements: requirementsSchema.nullable().optional(),
});

export async function partnerScoreRoutes(app: FastifyInstance) {
  // A job post → what it asks for (title, required / nice-to-have skills), for the score's job match.
  app.post("/api/v1/partner/job/requirements", { preHandler: requirePartner }, async (request: PartnerRequest, reply) => {
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    try {
      const data = await withAiUsageContext({ flowType: `partner:${request.partner}:job_analysis` }, () => getAIProvider().analyzeJobDescription(parsed.data.jobDescription));
      return reply.send({ data: { requirements: isEmptyJobAnalysis(data) ? null : data }, error: null });
    } catch (err) {
      request.log.error({ err }, "partner job analysis failed");
      return sendError(reply, 502, "JOB_ANALYSIS_FAILED", "Could not read this job description right now. Please try again.");
    }
  });

  // AI polish: rewrites what the failing checks point at, without inventing facts. Returns the new content.
  app.post("/api/v1/partner/cv/polish", { preHandler: requirePartner }, async (request: PartnerRequest, reply) => {
    const parsed = polishSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    const content = normalizeCvContent(parsed.data.content);
    const job = parsed.data.jobRequirements ?? null;
    const before = scoreContent(content, job, parsed.data.templateId);
    const targets = parsed.data.targets === "all" ? allPolishTargets(before) : parsed.data.targets;
    const usable = targets.filter((t) => t.kind !== "headline" || job);
    const input = buildPolishInput(content, usable, before, job);
    const hasWork = input.summary !== undefined || input.headline !== undefined || input.skills !== undefined || (input.roles?.length ?? 0) > 0;
    if (!hasWork || !input.cvText) return sendError(reply, 400, "NOTHING_TO_POLISH", "There's nothing AI can improve here yet. Fill in the highlighted details first.");
    try {
      const result = await withAiUsageContext({ flowType: `partner:${request.partner}:polish` }, () => getAIProvider().polishCv(input));
      const patch = sanitizePolish(content, input, result);
      const polished = applyPolishPatch(content, patch);
      const after = scoreContent(polished, job, parsed.data.templateId);
      return reply.send({ data: { content: polished, score: before.total, projectedScore: after.total }, error: null });
    } catch (err) {
      request.log.error({ err }, "partner CV polish failed");
      return sendError(reply, 502, "CV_POLISH_FAILED", "Could not polish this CV right now. Please try again.");
    }
  });

  // "AI check": recruiter-style tips. Never changes the score.
  app.post("/api/v1/partner/cv/review", { preHandler: requirePartner }, async (request: PartnerRequest, reply) => {
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    const content = normalizeCvContent(parsed.data.content);
    const cvText = cvPlainText(content);
    if (!cvText) return sendError(reply, 400, "CV_EMPTY", "Add some content to your CV first.");
    const job = parsed.data.jobRequirements ?? null;
    const score = scoreContent(content, job, parsed.data.templateId);
    try {
      const tips = await withAiUsageContext({ flowType: `partner:${request.partner}:review` }, () =>
        getAIProvider().reviewCv({ cvText, job: job ?? undefined, issues: failingIssues(score) }),
      );
      return reply.send({ data: { tips }, error: null });
    } catch (err) {
      request.log.error({ err }, "partner CV review failed");
      return sendError(reply, 502, "CV_REVIEW_FAILED", "Could not review this CV right now. Please try again.");
    }
  });
}
