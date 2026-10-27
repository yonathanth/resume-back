import { APIError } from "openai";
import { getAIProvider } from "./ai";
import type { AIGenerateInput } from "./ai";
import { roleMismatchSchema, type AnalyzeResult, type RoleMismatch } from "../schemas/cv-content.schema";
import { getAIOptionalSections, getCVTemplate } from "../config/cv-templates";
import { normalizeEnhancementLevel } from "./ai/cv/generation/enhancement";
import type { ProfileDefaults } from "./profileDefaults.service";
import {
  validateAnalyzeResult,
  type CvUserIdentity,
  type GeneratedCvContext,
} from "./ai/cv/generation/validateGeneratedCv";

// The CV generation prompt (rules + schema) is large enough that a single
// call can use most of a free-tier per-minute token budget — two calls in
// quick succession (e.g. the app's own analyze-then-refine flow) can 429.
// Thrown so the route can tell rate limits apart from real failures.
export class AIRateLimitedError extends Error {
  constructor(retryAfterMs: number) {
    super(`AI provider rate-limited; retry after ~${Math.ceil(retryAfterMs / 1000)}s`);
  }
}

// The model's output still didn't match the schema after one repair pass.
export class AIInvalidOutputError extends Error {
  constructor(issues: string) {
    super(`AI output failed validation after repair:
${issues}`);
  }
}

// 429 (rate limited) and 503 (model temporarily overloaded) are both
// transient on Groq's side and worth one backed-off retry; anything else
// (auth errors, bad request, etc.) is not — retrying those just burns a
// duplicate AI call for a failure that will repeat identically.
const RETRYABLE_STATUSES = new Set([429, 503]);

function getRetryAfterMs(err: unknown, attempt: 1 | 2): number | null {
  if (!(err instanceof APIError) || !RETRYABLE_STATUSES.has(err.status as number)) return null;
  const header = err.headers?.get?.("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  // No Retry-After header (typical for a 503) — back off exponentially
  // instead of hammering an already-overloaded model: 5s, then 10s.
  return 5_000 * 2 ** (attempt - 1);
}

export interface GenerateCVInput {
  sourceText: string;
  jobDescription?: string;
  templateId: string;
  /** 0–1, defaults to 0.5. Controls writing intensity only — never factual flexibility. */
  enhancementLevel?: number;
  /** Explicit, authoritative identity fields collected by the frontend. */
  name?: string;
  email?: string;
  /** Account contact details used where the source is silent (see profileDefaults.service.ts). */
  profileDefaults?: ProfileDefaults;
  /** Skills recorded on this CV's career profile — carried
   * forward so a new CV for the same role doesn't lose them. */
  knownSkills?: string[];
  /** A short, explicit instruction for what to emphasize or rewrite toward
   * (e.g. the Enhance flow's improvement-goal field) — see AIGenerateInput. */
  focusInstructions?: string;
}

function formatValidationIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `- ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("\n");
}

async function generateWithRetry(
  provider: ReturnType<typeof getAIProvider>,
  input: AIGenerateInput
): Promise<AnalyzeResult | RoleMismatch> {
  try {
    return await provider.generateCV(input);
  } catch (err) {
    const retryAfterMs = getRetryAfterMs(err, 1);
    if (retryAfterMs === null) throw err;

    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterMs, 20_000)));
    try {
      return await provider.generateCV(input);
    } catch (retryErr) {
      const retryAgainMs = getRetryAfterMs(retryErr, 2);
      if (retryAgainMs !== null) {
        throw new AIRateLimitedError(retryAgainMs);
      }
      throw retryErr;
    }
  }
}

/**
 * Analysis and generation share this one AI call: it structures the
 * candidate data, tailors it (job description + enhancement level), checks
 * job compatibility, and flags clarification questions — all in a single
 * combined response (see clarification.rules.ts for why this stays one
 * call rather than a fully staged pipeline). The caller decides whether to
 * persist the result (POST /cv/:id/generate) or just show it to the user
 * (POST /cv/analyze) — this function never touches the database.
 *
 * One self-correction pass: if the model's JSON is well-formed but doesn't
 * match the expected shape (e.g. it drifted to generic resume-JSON field
 * names like "position"/"startDate"/"name" instead of this app's
 * "role"/"start_date"/"full_name"), feed the exact validation errors back
 * and ask for a corrected object before giving up.
 */
export async function generateCVContent(input: GenerateCVInput): Promise<AnalyzeResult | RoleMismatch> {
  const provider = getAIProvider();
  const template = getCVTemplate(input.templateId);
  const optionalSections = getAIOptionalSections(input.templateId);
  const enhancementLevel = normalizeEnhancementLevel(input.enhancementLevel);
  const userIdentity: CvUserIdentity | undefined =
    input.name || input.email ? { name: input.name, email: input.email } : undefined;

  const sourceText = input.knownSkills?.length
    ? `${input.sourceText}\n\nSkills recorded on the candidate's career profile for this role: ${input.knownSkills.join(", ")}`
    : input.sourceText;

  const providerInput: AIGenerateInput = {
    sourceText,
    jobDescription: input.jobDescription,
    templateId: template.id,
    templateName: template.name,
    templateNotes: template.aiNotes,
    optionalSections,
    enhancementLevel,
    userIdentity,
    profileDefaults: input.profileDefaults,
    focusInstructions: input.focusInstructions,
  };
  const context: GeneratedCvContext = {
    templateId: input.templateId,
    userIdentity,
    profileDefaults: input.profileDefaults,
  };

  const first = await generateWithRetry(provider, providerInput);
  const firstMismatch = roleMismatchSchema.safeParse(first);
  if (firstMismatch.success) {
    return firstMismatch.data;
  }

  const firstValidation = validateAnalyzeResult(first, context);
  if (firstValidation.success) {
    return firstValidation.data;
  }

  let repaired: AnalyzeResult | RoleMismatch;
  try {
    repaired = await provider.generateCV({
      ...providerInput,
      repairNotes: formatValidationIssues(firstValidation.error.issues),
    });
  } catch (err) {
    const retryAfterMs = getRetryAfterMs(err, 1);
    if (retryAfterMs !== null) throw new AIRateLimitedError(retryAfterMs);
    throw err;
  }
  const repairedMismatch = roleMismatchSchema.safeParse(repaired);
  if (repairedMismatch.success) {
    return repairedMismatch.data;
  }
  const repairedValidation = validateAnalyzeResult(repaired, context);
  if (repairedValidation.success) {
    return repairedValidation.data;
  }
  // Never hand unvalidated output to the caller — it would only fail later
  // (e.g. when persisted via /cv/:id/generate) with a confusing error.
  throw new AIInvalidOutputError(formatValidationIssues(repairedValidation.error.issues));
}
