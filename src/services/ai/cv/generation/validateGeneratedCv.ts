import { validateCVContent, analyzeResultSchema, type AnalyzeResult } from "../../../../schemas/cv-content.schema";
import { isPlainObject, stripEmptyValues } from "../../../../utils/merge-content";
import { normalizeCvContent } from "../../../../utils/normalize-content";
import { stripUnsupportedSections } from "./sectionRules";
import { getCVTemplate } from "../../../../config/cv-templates";
import { CV_SECTION_CATALOG } from "../../../../config/cv-sections";
import type { PersonalDefaultKey, ProfileDefaults } from "../../../profileDefaults.service";
import { MAX_CLARIFICATION_QUESTIONS } from "../rules/clarification.rules";

export interface CvUserIdentity {
  name?: string;
  email?: string;
}

export interface GeneratedCvContext {
  templateId: string;
  userIdentity?: CvUserIdentity;
  /** Account details that fill personal fields the source left empty. */
  profileDefaults?: ProfileDefaults;
}

// Question ids the model uses for each personal field — once the field is
// filled (from the source or the account), these questions are dropped.
const PERSONAL_QUESTION_IDS: Record<PersonalDefaultKey, string[]> = {
  full_name: ["full_name", "name", "candidate_name", "your_name"],
  email: ["email", "email_address", "contact_email"],
  phone: ["phone", "phone_number", "contact_phone", "mobile"],
  title: ["title", "job_title", "professional_title", "target_title", "target_job_title", "headline", "current_title"],
};

// The CV renders plain text, so markdown emphasis the model adds (often around
// text it just added, e.g. "**AWS**") would show up as literal asterisks.
function stripMarkdownEmphasis(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*\*/g, "").trim();
  if (Array.isArray(value)) return value.map(stripMarkdownEmphasis);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, stripMarkdownEmphasis(v)]));
  }
  return value;
}

/**
 * Enforces, in code rather than only in the prompt, the two guarantees the
 * rules ask the model for: (1) only template-supported sections come back,
 * and (2) an explicitly provided name/email is never altered by the model.
 * Runs before validation so validateCVContent always sees already-sanitized
 * data — see aiGeneration.service.ts and cv.routes.ts, the two callers.
 */
export function sanitizeGeneratedCv(data: unknown, context: GeneratedCvContext): unknown {
  if (!isPlainObject(data)) return data;

  // null / "" mean "unknown" coming from the model; the schemas express that
  // as an absent key, so drop them before anything else looks at the data.
  const cleaned = normalizeCvContent(stripEmptyValues(stripMarkdownEmphasis(data)) as Record<string, unknown>);
  const stripped = stripUnsupportedSections(cleaned, context.templateId);
  if (!isPlainObject(stripped.personal)) stripped.personal = {};

  const { name, email } = context.userIdentity ?? {};
  if (name || email) {
    const personal = isPlainObject(stripped.personal) ? stripped.personal : {};
    stripped.personal = {
      ...personal,
      ...(name ? { full_name: name } : {}),
      ...(email ? { email } : {}),
    };
  }

  // Account defaults only fill gaps — the user's own material always wins.
  const defaults = context.profileDefaults;
  if (defaults) {
    const personal = isPlainObject(stripped.personal) ? { ...stripped.personal } : {};
    for (const key of Object.keys(PERSONAL_QUESTION_IDS) as PersonalDefaultKey[]) {
      if (!personal[key] && defaults[key]) personal[key] = defaults[key];
    }
    stripped.personal = personal;
  }

  return stripped;
}

/** Drops questions about personal fields the CV already has. */
function withoutAnsweredPersonalQuestions(candidateData: unknown, questions: unknown[]): unknown[] {
  const personal = isPlainObject(candidateData) && isPlainObject(candidateData.personal) ? candidateData.personal : {};
  const answeredIds = new Set(
    (Object.keys(PERSONAL_QUESTION_IDS) as PersonalDefaultKey[])
      .filter((key) => Boolean(personal[key]))
      .flatMap((key) => PERSONAL_QUESTION_IDS[key])
  );
  return questions.filter((q) => !(isPlainObject(q) && typeof q.id === "string" && answeredIds.has(q.id)));
}

export function validateGeneratedCv(data: unknown, context: GeneratedCvContext) {
  const sanitized = sanitizeGeneratedCv(data, context);
  return validateCVContent(sanitized, { partial: true });
}

// Asked whenever the CV is missing one of these, whether or not the model
// remembered to ask — it often doesn't, and a CV can't be finalized without them.
const REQUIRED_PERSONAL_QUESTIONS = [
  { field: "full_name", question: "What is your full name?" },
  { field: "title", question: "What professional title should appear at the top of your CV?" },
  { field: "email", question: "What email address should employers contact you at?" },
] as const;

function withRequiredPersonalQuestions(candidateData: unknown, questions: unknown[]): unknown[] {
  const personal = isPlainObject(candidateData) && isPlainObject(candidateData.personal) ? candidateData.personal : {};
  const askedIds = new Set(questions.map((q) => (isPlainObject(q) ? q.id : undefined)));
  const added = REQUIRED_PERSONAL_QUESTIONS.filter(({ field }) => !personal[field] && !askedIds.has(field)).map(
    ({ field, question }) => ({
      id: field,
      question,
      reason: "Required for a complete CV and not found in what you provided.",
      type: "text",
      required: true,
    })
  );
  return [...added, ...questions];
}

/**
 * One question per section the template marks `askIfMissing` when the user's
 * material produced nothing for it. Ids are `section_<key>`; the frontend
 * folds the answer into the next AI pass, which places it in that section.
 */
function withMissingSectionQuestions(candidateData: unknown, questions: unknown[], templateId: string): unknown[] {
  const content = isPlainObject(candidateData) ? candidateData : {};
  const askedIds = new Set(questions.map((q) => (isPlainObject(q) ? q.id : undefined)));
  const added = (getCVTemplate(templateId).askIfMissing ?? []).flatMap((key) => {
    const section = CV_SECTION_CATALOG[key];
    const id = `section_${key}`;
    const hasContent = section.contentKeys.some((k) => {
      const value = content[k];
      return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : Boolean(value);
    });
    if (hasContent || !section.missingQuestion || askedIds.has(id)) return [];
    return [{ id, ...section.missingQuestion, required: false }];
  });
  return [...questions, ...added];
}

// "Could you confirm…", "verify", "double-check" — asking to re-state what the
// material already says. Never useful: the CV uses what was given as is.
const CONFIRMATION = /\b(confirm|verify|double[- ]?check|make sure|is (?:this|that|it) (?:correct|right|accurate))\b/i;
const DATE_ASK = /\b(start|end|finish|finished|dates?|when did|joined|left|graduat\w*)\b/i;
const TITLE_ASK = /\b(job title|exact title|your title|position|degree|major|studying|pursuing)\b/i;
const EDUCATION_ASK = /\b(school|university|college|institution|degree|major|studying|pursuing|graduat\w*)\b/i;

/**
 * Drops model questions about facts the CV already has (the prompt says not
 * to ask them; this makes sure): every "please confirm" question, questions
 * naming a company or school whose entry already has the asked-for facts, and
 * education questions when every education entry is complete. Questions that
 * deepen an entry ("how many users…") are kept.
 */
function withoutAnsweredEntryQuestions(candidateData: unknown, questions: unknown[]): unknown[] {
  const content = isPlainObject(candidateData) ? candidateData : {};
  const entries = (v: unknown) => (Array.isArray(v) ? v.filter(isPlainObject) : []);
  const experience = entries(content.experience);
  const education = entries(content.education);
  const educationComplete = education.length > 0 && education.every((e) => nonEmpty(e.institution) && nonEmpty(e.degree) && nonEmpty(e.end_date));

  return questions.filter((q) => {
    if (!isPlainObject(q)) return true;
    const text = `${typeof q.question === "string" ? q.question : ""}`;
    const lower = text.toLowerCase();
    if (CONFIRMATION.test(text)) return false;

    const asksDates = DATE_ASK.test(text);
    const asksTitle = TITLE_ASK.test(text);
    for (const e of experience) {
      const company = nonEmpty(e.company)?.toLowerCase();
      if (!company || !lower.includes(company)) continue;
      const datesKnown = Boolean(nonEmpty(e.start_date) && nonEmpty(e.end_date));
      // Only a question about this entry's known facts is dropped; one asking for anything else stays.
      if ((asksDates && datesKnown && !asksTitle) || (asksTitle && nonEmpty(e.role) && !asksDates)) return false;
      if (asksDates && asksTitle && datesKnown && nonEmpty(e.role)) return false;
    }
    if (EDUCATION_ASK.test(text) && (asksDates || asksTitle || /\b(name|which|where)\b/i.test(text))) {
      if (educationComplete) return false;
      const named = education.find((e) => nonEmpty(e.institution) && lower.includes(nonEmpty(e.institution)!.toLowerCase()));
      if (named && nonEmpty(named.degree) && nonEmpty(named.end_date)) return false;
    }
    return true;
  });
}

// A model question counts as covering an entry's missing name/dates only if
// it asks for exactly that — "which role are you aiming for?" must not count.
const EXPERIENCE_WORDS = /company|employer|organi[sz]ation|business name|called/i;
const EDUCATION_WORDS = /school|university|college|institution/i;

/** A short label for an entry, so a question can say which one it means. */
function describeEntry(entry: Record<string, unknown>, nameKeys: string[]): string {
  for (const key of nameKeys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return `"${value.trim()}"`;
  }
  const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];
  const first = bullets[0];
  const text = typeof first === "string" ? first : isPlainObject(first) && typeof first.text === "string" ? first.text : "";
  return text ? `"${text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text}"` : "one you described";
}

/** "a", "a and b", "a, b and c" */
function joinAsks(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Real entries the model kept but couldn't name or date (see HARD FACTS in
 * hallucination.rules.ts) always get one combined, optional question each —
 * unless the model already asked about them itself. The question asks only
 * for the fields still missing, never for ones the entry already has.
 */
function withEntryDetailQuestions(candidateData: unknown, questions: unknown[]): unknown[] {
  const content = isPlainObject(candidateData) ? candidateData : {};
  const questionTexts = questions.map((q) => (isPlainObject(q) ? `${q.id ?? ""} ${q.question ?? ""}` : ""));
  const asked = (pattern: RegExp) => questionTexts.filter((t) => pattern.test(t)).length;
  // A model question naming the entry (e.g. "When did you start at Shalops?") already covers it.
  const mentions = (name: string | undefined) =>
    Boolean(name) && questionTexts.some((t) => t.toLowerCase().includes(name!.toLowerCase()));

  const build = (
    items: unknown,
    isIncomplete: (e: Record<string, unknown>) => boolean,
    nameOf: (e: Record<string, unknown>) => string | undefined,
    alreadyAsked: number,
    make: (e: Record<string, unknown>, i: number) => Record<string, unknown>
  ) =>
    (Array.isArray(items) ? items : [])
      .map((e, i) => ({ e, i }))
      .filter((x): x is { e: Record<string, unknown>; i: number } => isPlainObject(x.e) && isIncomplete(x.e))
      .filter(({ e }) => !mentions(nameOf(e)))
      .slice(alreadyAsked)
      .map(({ e, i }) => make(e, i));

  const experience = build(
    content.experience,
    (e) => !e.company || !e.start_date,
    (e) => nonEmpty(e.company),
    asked(EXPERIENCE_WORDS),
    (e, i) => {
      const company = nonEmpty(e.company);
      const asks = [
        ...(company ? [] : ["what was the company called"]),
        ...(e.role ? [] : ["what was your job title"]),
        ...(e.start_date ? [] : ["when did you start and finish"]),
      ];
      const subject = company ? `your role at ${company}` : `the role ${describeEntry(e, ["role"])}`;
      return {
        id: `experience_${i}_details`,
        question: `About ${subject}: ${joinAsks(asks)}?`,
        reason: "Names and dates make this role credible, and we won't guess them.",
        type: "textarea",
        required: false,
      };
    }
  );
  const education = build(
    content.education,
    (e) => !e.institution || !e.end_date,
    (e) => nonEmpty(e.institution),
    asked(EDUCATION_WORDS),
    (e, i) => {
      const institution = nonEmpty(e.institution);
      const asks = [
        ...(institution ? [] : ["which school or university"]),
        ...(e.degree ? [] : ["what degree"]),
        ...(e.end_date ? [] : ["when did you (or will you) finish"]),
      ];
      const subject = institution
        ? `your studies at ${institution}`
        : `your studies ${describeEntry(e, ["field", "degree"])}`;
      return {
        id: `education_${i}_details`,
        question: `About ${subject}: ${joinAsks(asks)}?`,
        reason: "We only add school names and dates you give us.",
        type: "textarea",
        required: false,
      };
    }
  );
  return [...experience, ...education, ...questions];
}

/**
 * Same idea as sanitizeGeneratedCv, but for the AI's wrapper shape
 * ({ candidateData, questions, jobAnalysis }) — only candidateData needs
 * section-stripping and authoritative-identity enforcement.
 */
export function sanitizeAnalyzeResult(data: unknown, context: GeneratedCvContext): unknown {
  if (!isPlainObject(data)) return data;

  const candidateData = isPlainObject(data.candidateData)
    ? sanitizeGeneratedCv(data.candidateData, context)
    : data.candidateData;

  // Order: required personal fields, entry names/dates, the model's own
  // questions, then empty-section prompts — capped so the flow stays short
  // (the frontend shows three per screen).
  const questions = withMissingSectionQuestions(
    candidateData,
    withRequiredPersonalQuestions(
      candidateData,
      withEntryDetailQuestions(
        candidateData,
        withoutAnsweredEntryQuestions(
          candidateData,
          withoutAnsweredPersonalQuestions(candidateData, Array.isArray(data.questions) ? data.questions : [])
        )
      )
    ),
    context.templateId
  ).slice(0, MAX_CLARIFICATION_QUESTIONS);

  return {
    candidateData,
    questions,
    jobAnalysis: stripMarkdownEmphasis(data.jobAnalysis) ?? null,
  };
}

export function validateAnalyzeResult(data: unknown, context: GeneratedCvContext) {
  const sanitized = sanitizeAnalyzeResult(data, context);
  return analyzeResultSchema.safeParse(sanitized);
}

export type { AnalyzeResult };
