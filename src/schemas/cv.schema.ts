import { z } from "zod";
import { cvContentSchema, PartialCVContent } from "./cv-content.schema";

export const createCVDocumentSchema = z.object({
  // Omit to create a standalone CV not attached to any career profile.
  profileId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
  // The CV this one is copied from (duplicate, or a flow starting from a
  // saved resume): an unpaid pay-per-CV lock carries over to the copy.
  sourceCvId: z.string().min(1).optional(),
});

export type CreateCVDocumentInput = z.infer<typeof createCVDocumentSchema>;

// null detaches the document from any career profile.
export const moveCVDocumentSchema = z.object({
  profileId: z.string().min(1).nullable(),
});

export type MoveCVDocumentInput = z.infer<typeof moveCVDocumentSchema>;

// Used to persist edits made in the free-form CV editor ("Done" action) —
// lenient/partial, unlike the strict per-step wizard schemas, since the
// editor lets a user leave sections incomplete while working.
export const updateCVContentSchema = z.object({
  content: PartialCVContent.optional(),
  templateId: z.string().min(1).optional(),
  jobDescription: z.string().nullable().optional(),
  // The document's own display name — distinct from content.personal.title.
  title: z.string().min(1).max(200).optional(),
});

export type UpdateCVContentInput = z.infer<typeof updateCVContentSchema>;

const enhancementLevelSchema = z
  .number()
  .min(0, "enhancementLevel must be between 0 and 1")
  .max(1, "enhancementLevel must be between 0 and 1")
  .default(0.5);

// Runs the AI (structuring + tailoring + job compatibility + clarification
// questions, all in one call — see aiGeneration.service.ts) without
// persisting anything. POST /cv/analyze uses this directly; POST
// /cv/:id/generate falls back to it when the caller didn't already run
// /cv/analyze and pass back `analyzedContent`.
// ~7.5k tokens each — comfortably more than a long multi-page CV or job
// posting, while stopping a single request from sending a whole book.
const MAX_SOURCE_TEXT_CHARS = 30_000;
const MAX_JOB_DESCRIPTION_CHARS = 15_000;

const sourceTextSchema = z
  .string()
  .min(1, "sourceText is required")
  .max(MAX_SOURCE_TEXT_CHARS, `Your CV text is too long. Keep it under ${MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters`);
const jobDescriptionSchema = z
  .string()
  .max(
    MAX_JOB_DESCRIPTION_CHARS,
    `The job description is too long. Keep it under ${MAX_JOB_DESCRIPTION_CHARS.toLocaleString("en-US")} characters`
  );

export const analyzeCVSchema = z.object({
  sourceText: sourceTextSchema,
  jobDescription: jobDescriptionSchema.optional(),
  enhancementLevel: enhancementLevelSchema,
  // Explicit identity fields, treated as authoritative and never altered by the AI.
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  templateId: z.string().min(1).optional(),
  // A short instruction for what to emphasize/rewrite toward (e.g. the
  // Enhance flow's improvement-goal field) — kept separate from sourceText
  // so the AI treats it as a directive, not more candidate narrative.
  focusInstructions: z.string().max(500).optional(),
  // Which dashboard tab this flow started from — required to charge the CV
  // (see entitlement.service.ts). Optional only for a CV already charged.
  flowType: z.enum(["create", "tailor", "improve"]).optional(),
  // Set by a flow's own refine/re-analysis step (useRefineCv), once the
  // document exists. A CV already charged isn't charged again; one that
  // isn't yet (copied from a saved resume or profile) is charged here.
  cvDocumentId: z.string().optional(),
  // Past the free CV / a Plus limit: go on, and pay for this CV at download.
  payLater: z.boolean().optional(),
  // The saved resume or career profile this flow reworks — prices a
  // pay-later CV as tailored / improved, and carries over a resume's lock.
  sourceCvId: z.string().min(1).optional(),
  sourceProfileId: z.string().min(1).optional(),
});

export type AnalyzeCVInput = z.infer<typeof analyzeCVSchema>;

// Powers the CV editor's "AI Polish" action on the Summary section — a
// narrow, stateless rewrite of just the summary text, grounded by (but never
// adding facts from) the rest of the CV. See openai-compatible.provider.ts#polishSummary.
export const polishSummarySchema = z.object({
  summary: z.string().min(1, "summary is required").max(3_000, "Summary is too long to polish"),
  title: z.string().max(200).optional(),
  skills: z.array(z.string()).max(50).optional(),
  experienceBullets: z.array(z.string()).max(50).optional(),
});

export type PolishSummaryRequest = z.infer<typeof polishSummarySchema>;

export const generateCVSchema = z
  .object({
    // Either provide sourceText (runs the AI here, same as /cv/analyze) or
    // analyzedContent (the `candidateData` from a prior /cv/analyze call —
    // skips the AI call and just persists it).
    sourceText: sourceTextSchema.optional(),
    analyzedContent: PartialCVContent.optional(),
    jobDescription: jobDescriptionSchema.optional(),
    enhancementLevel: enhancementLevelSchema,
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    focusInstructions: z.string().max(500).optional(),
    // Replace the document's content wholesale instead of only filling its
    // empty fields — used by the frontend's refine step, whose rewrite would
    // otherwise be discarded by the fill-only merge.
    replaceContent: z.boolean().optional(),
    // Only required on the sourceText path (analyzedContent was already
    // charged by whatever produced it, normally POST /cv/analyze).
    flowType: z.enum(["create", "tailor", "improve"]).optional(),
    // From POST /cv/analyze: the charge for a CV not charged yet. Saving
    // analyzedContent into an uncharged CV requires it.
    chargeToken: z.string().min(1).max(2000).optional(),
    payLater: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.sourceText || data.analyzedContent), {
    message: "Either sourceText or analyzedContent is required",
    path: ["sourceText"],
  });

export type GenerateCVInput = z.infer<typeof generateCVSchema>;

export const STEP_ORDER = [
  "personal",
  "summary",
  "experience",
  "education",
  "skills",
  "certifications",
  "projects",
  "languages",
  "review",
] as const;

export type StepName = (typeof STEP_ORDER)[number];

// Per-section schemas derived from cv-content.schema.ts so step validation
// always stays in sync with the canonical CVContent shape.
export const CONTENT_STEP_SCHEMAS = {
  personal: cvContentSchema.shape.personal,
  summary: cvContentSchema.shape.summary,
  experience: cvContentSchema.shape.experience,
  education: cvContentSchema.shape.education,
  skills: cvContentSchema.shape.skills,
  certifications: cvContentSchema.shape.certifications,
  projects: cvContentSchema.shape.projects,
  languages: cvContentSchema.shape.languages,
};

export type ContentStep = keyof typeof CONTENT_STEP_SCHEMAS;

// ── CV score (services/score) ───────────────────────────────────────────────

// Runs (or returns the cached) AI extraction of the CV's job description.
// Sending jobDescription saves it first, so the editor needn't wait for autosave.
export const jobAnalysisRequestSchema = z.object({
  jobDescription: jobDescriptionSchema.optional(),
});

// The editor sends its current, possibly unsaved content so tips and rewrites
// match what the user sees; without it the saved content is used.
export const reviewCvSchema = z.object({
  content: PartialCVContent.optional(),
});

export const polishTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary") }),
  z.object({ kind: z.literal("bullets"), index: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal("skills") }),
  z.object({ kind: z.literal("headline") }),
]);

export const polishCvSchema = z.object({
  content: PartialCVContent.optional(),
  targets: z.union([z.literal("all"), z.array(polishTargetSchema).min(1).max(20)]),
});

export type PolishCvRequest = z.infer<typeof polishCvSchema>;
