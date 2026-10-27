import type { AnalyzeResult, RoleMismatch } from "../../schemas/cv-content.schema";
import type { CVSectionKey } from "../../config/cv-sections";
import type { ProfileDefaults } from "../profileDefaults.service";

export interface CvUserIdentity {
  name?: string;
  email?: string;
}

export interface AIGenerateInput {
  sourceText: string;
  jobDescription?: string;
  templateId: string;
  /** Non-core sections the chosen template shows — the only optional ones requested. */
  optionalSections: CVSectionKey[];
  /** The template's display name and its template-specific AI notes (see cv-templates.ts). */
  templateName?: string;
  templateNotes?: string;
  /**
   * 0–1. Controls writing intensity (how much the AI may rewrite, expand,
   * and strengthen wording) — it never changes what may be treated as fact.
   * See src/services/ai/cv/rules/enhancement.rules.ts.
   */
  enhancementLevel: number;
  /** Explicitly provided name/email, treated as authoritative and never altered by the model. */
  userIdentity?: CvUserIdentity;
  /** Contact details from the user's account — use only where the source is silent. */
  profileDefaults?: ProfileDefaults;
  /**
   * A short, explicit instruction for what to emphasize or rewrite toward
   * (e.g. "Quantify metrics using the XYZ formula" from the Enhance flow's
   * improvement-goal field). Rendered in its own high-priority block in the
   * user message rather than folded into sourceText, so it reads as a
   * directive rather than more candidate narrative — but it is still bound
   * by the FACTUAL BOUNDARY like everything else.
   */
  focusInstructions?: string;
  /** Set on a self-correction retry: the exact validation errors from the previous attempt. */
  repairNotes?: string;
}

export interface PolishSummaryInput {
  /** The candidate's current professional summary text, as typed/edited so far. */
  summary: string;
  /** Grounding context only — never a source of new claims the summary itself doesn't already make. */
  title?: string;
  skills?: string[];
  experienceBullets?: string[];
}

export interface RoleMatchInput {
  /** The role a new CV is for, e.g. "React Developer". */
  role: string;
  /** The user's existing career profiles. */
  profiles: { id: string; title: string }[];
}

/** How a profile relates to the new CV's role. Profiles that are unrelated are left out. */
export interface RoleMatch {
  profileId: string;
  relation: "same" | "related";
}

export interface AIProvider {
  generateCV(input: AIGenerateInput): Promise<AnalyzeResult | RoleMismatch>;
  /** Rewrites a CV's professional summary for clarity, tone, and ATS
   * friendliness without inventing new facts — powers the editor's "AI
   * Polish" action on the Summary section. */
  polishSummary(input: PolishSummaryInput): Promise<string>;
  /** Tiny classification call: which existing career profiles are the same
   * role as a new CV, or a related one. Only used when the free deterministic
   * match (services/roleKey.service.ts) finds nothing. */
  classifyRoleMatch(input: RoleMatchInput): Promise<RoleMatch[]>;
  /** Pulls a job description's requirements out as lists — run once per job
   * description and stored, so the CV score's job match never drifts. */
  analyzeJobDescription(jobDescription: string): Promise<JobRequirements>;
  /** Written tips for the CV score panel's "AI check". Never changes the score. */
  reviewCv(input: ReviewCvInput): Promise<ReviewTip[]>;
  /** Rewrites the requested parts of a CV to fix failing score checks (Pro "AI polish"). */
  polishCv(input: PolishCvInput): Promise<PolishCvResult>;
}

/** What a job asks for, extracted once per job description (see services/score). */
export interface JobRequirements {
  title: string;
  seniority: string;
  requiredSkills: string[];
  preferredSkills: string[];
  keywords: string[];
}

/** A failing CV score check, as the review and polish prompts see it. */
export interface ScoreIssue {
  label: string;
  message: string;
}

export interface ReviewCvInput {
  /** The CV as plain text (contact details left out). */
  cvText: string;
  job?: JobRequirements;
  issues: ScoreIssue[];
}

export interface ReviewTip {
  section: string;
  text: string;
}

/** The parts of the CV polish may rewrite — only the ones asked for are sent and returned. */
export interface PolishCvInput {
  /** Everything the CV says, as plain text — the facts the rewrite must stay within. */
  cvText: string;
  job?: JobRequirements;
  issues: ScoreIssue[];
  summary?: string;
  /** Roles whose bullets to rewrite, by their index in content.experience. */
  roles?: { index: number; role: string; company: string; bullets: string[] }[];
  skills?: string[];
  headline?: string;
}

export interface PolishCvResult {
  summary?: string;
  roles?: { index: number; bullets: string[] }[];
  skillGroups?: { category: string; items: string[] }[];
  headline?: string;
}
