import { z } from "zod";

export const linkSchema = z.object({
  label: z.string(),
  url: z.string(),
});

// A bullet is `{ label?, text }` — the optional label is the short bold lead-in
// some templates render ("Frontend Architecture: Led development of..."). A
// plain string is still accepted everywhere and converted, so content written
// before bullets were structured (and the occasional AI slip) stays valid.
export const bulletObjectSchema = z.object({
  label: z.string().optional(),
  text: z.string(),
});
const bulletSchema = z.preprocess(
  (value) => (typeof value === "string" ? { text: value } : value),
  bulletObjectSchema
);
const partialBulletSchema = z.preprocess(
  (value) => (typeof value === "string" ? { text: value } : value),
  bulletObjectSchema.partial()
);

export type CVBullet = z.infer<typeof bulletObjectSchema>;

// A small headshot, uploaded in the editor (never AI-generated) and stored
// inline so no file storage is needed. The frontend resizes it before upload;
// the cap keeps one oversized image from bloating every save and render.
const MAX_PHOTO_DATA_URL_CHARS = 300_000;
const photoSchema = z
  .string()
  .max(MAX_PHOTO_DATA_URL_CHARS, "Photo is too large. Use a smaller image")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Photo must be a PNG, JPEG, or WebP image");

const personalSchema = z.object({
  full_name: z.string(),
  title: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  location: z.string().optional(),
  links: z.array(linkSchema).optional(),
  photo: photoSchema.optional(),
});

export const experienceEntrySchema = z.object({
  company: z.string(),
  role: z.string(),
  location: z.string().optional(),
  url: z.string().optional(),
  start_date: z.string(),
  end_date: z.union([z.string(), z.literal("present")]),
  bullets: z.array(bulletSchema),
});

export const educationEntrySchema = z.object({
  institution: z.string(),
  degree: z.string(),
  field: z.string().optional(),
  location: z.string().optional(),
  gpa: z.string().optional(),
  start_date: z.string().optional(),
  // Free text, so "Expected 2026" works as well as "2026-06".
  end_date: z.string().optional(),
  honors: z.string().optional(),
  // Thesis title, final grade, notable coursework.
  bullets: z.array(bulletSchema).optional(),
});

export const certificationSchema = z.object({
  name: z.string(),
  // Optional — the AI correctly omits this when the source text doesn't
  // name a specific issuing body, rather than guessing one.
  issuer: z.string().optional(),
  date: z.string().optional(),
  expires: z.string().optional(),
  url: z.string().optional(),
});

export const projectSchema = z.object({
  name: z.string(),
  // One-line description shown under the name ("Offline-first desktop + web platform").
  subtitle: z.string().optional(),
  description: z.string().optional(),
  tech: z.array(z.string()).optional(),
  url: z.string().optional(),
  bullets: z.array(bulletSchema).optional(),
});

export const languageSchema = z.object({
  language: z.string(),
  proficiency: z.string(),
});

export const awardSchema = z.object({
  title: z.string(),
  issuer: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
});

export const publicationSchema = z.object({
  title: z.string(),
  authors: z.string().optional(),
  // Journal, conference, or publisher.
  venue: z.string().optional(),
  date: z.string().optional(),
  url: z.string().optional(),
});

export const volunteeringSchema = z.object({
  organization: z.string(),
  role: z.string().optional(),
  location: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.union([z.string(), z.literal("present")]).optional(),
  bullets: z.array(bulletSchema).optional(),
});

export const courseSchema = z.object({
  name: z.string(),
  institution: z.string().optional(),
  date: z.string().optional(),
});

export const membershipSchema = z.object({
  organization: z.string(),
  role: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.union([z.string(), z.literal("present")]).optional(),
});

export const presentationSchema = z.object({
  title: z.string(),
  event: z.string().optional(),
  date: z.string().optional(),
  url: z.string().optional(),
});

export const referenceSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  organization: z.string().optional(),
  relationship: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

// Europass-style facts (date of birth, nationality, driving licence...) as
// label/value pairs, so templates that show them don't need a field per fact.
export const personalDetailSchema = z.object({
  label: z.string(),
  value: z.string(),
});

// Research, teaching and activities all share the experience-like shape.
export const positionSchema = z.object({
  title: z.string(),
  organization: z.string().optional(),
  location: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.union([z.string(), z.literal("present")]).optional(),
  bullets: z.array(bulletSchema).optional(),
});

// Categorized skills ("Frontend: React, Next.js"). `skills` stays the flat
// list every skill also appears in — it's what keyword matching and the
// finalize check use; see normalizeCvContent.
export const skillGroupSchema = z.object({
  category: z.string(),
  items: z.array(z.string()),
});

export const cvContentSchema = z.object({
  personal: personalSchema,
  summary: z.string().optional(),
  experience: z.array(experienceEntrySchema),
  education: z.array(educationEntrySchema),
  skills: z.array(z.string()),
  skillGroups: z.array(skillGroupSchema).optional(),
  certifications: z.array(certificationSchema).optional(),
  projects: z.array(projectSchema).optional(),
  languages: z.array(languageSchema).optional(),
  awards: z.array(awardSchema).optional(),
  publications: z.array(publicationSchema).optional(),
  volunteering: z.array(volunteeringSchema).optional(),
  courses: z.array(courseSchema).optional(),
  memberships: z.array(membershipSchema).optional(),
  presentations: z.array(presentationSchema).optional(),
  interests: z.array(z.string()).optional(),
  references: z.array(referenceSchema).optional(),
  personalDetails: z.array(personalDetailSchema).optional(),
  research: z.array(positionSchema).optional(),
  teaching: z.array(positionSchema).optional(),
  activities: z.array(positionSchema).optional(),
  consent: z.string().max(2_000).optional(),
});

export type CVContent = z.infer<typeof cvContentSchema>;

// "" is allowed for email here — the editor sends a cleared field as "" while
// a draft is in progress. finalize still validates against the strict schema.
const partialPersonalSchema = personalSchema.partial().extend({
  email: z.union([z.literal(""), z.string().email()]).optional(),
  links: z.array(linkSchema.partial()).optional(),
});

const partialExperienceEntrySchema = experienceEntrySchema.partial().extend({
  bullets: z.array(partialBulletSchema).optional(),
});

const partialEducationEntrySchema = educationEntrySchema.partial().extend({
  bullets: z.array(partialBulletSchema).optional(),
});

const partialPositionSchema = positionSchema.partial().extend({
  bullets: z.array(partialBulletSchema).optional(),
});

const partialCertificationSchema = certificationSchema.partial();

const partialProjectSchema = projectSchema.partial().extend({
  tech: z.array(z.string()).optional(),
  bullets: z.array(partialBulletSchema).optional(),
});

const partialLanguageSchema = languageSchema.partial();

const partialSkillGroupSchema = skillGroupSchema.partial();

const partialVolunteeringSchema = volunteeringSchema.partial().extend({
  bullets: z.array(partialBulletSchema).optional(),
});

// Sections shared verbatim by the partial (editor/analysis) and generated shapes.
const partialExtraSections = {
  awards: z.array(awardSchema.partial()).optional(),
  publications: z.array(publicationSchema.partial()).optional(),
  volunteering: z.array(partialVolunteeringSchema).optional(),
  courses: z.array(courseSchema.partial()).optional(),
  memberships: z.array(membershipSchema.partial()).optional(),
  presentations: z.array(presentationSchema.partial()).optional(),
  interests: z.array(z.string()).optional(),
  references: z.array(referenceSchema.partial()).optional(),
  personalDetails: z.array(personalDetailSchema.partial()).optional(),
  research: z.array(partialPositionSchema).optional(),
  teaching: z.array(partialPositionSchema).optional(),
  activities: z.array(partialPositionSchema).optional(),
  consent: z.string().max(2_000).optional(),
};

export const PartialCVContent = z.object({
  personal: partialPersonalSchema.optional(),
  summary: z.string().optional(),
  experience: z.array(partialExperienceEntrySchema).optional(),
  education: z.array(partialEducationEntrySchema).optional(),
  skills: z.array(z.string()).optional(),
  skillGroups: z.array(partialSkillGroupSchema).optional(),
  certifications: z.array(partialCertificationSchema).optional(),
  projects: z.array(partialProjectSchema).optional(),
  languages: z.array(partialLanguageSchema).optional(),
  ...partialExtraSections,
});

export type PartialCVContent = z.infer<typeof PartialCVContent>;

// personal/experience(>=1)/skills(>=1) required, everything else optional — for AI-generated content,
// which may not populate every section but must cover the fields that make a document usable.
const generatedCVContentSchema = z.object({
  personal: partialPersonalSchema,
  summary: z.string().optional(),
  experience: z.array(partialExperienceEntrySchema).min(1, "At least one experience entry is required"),
  education: z.array(partialEducationEntrySchema).optional(),
  skills: z.array(z.string()).min(1, "At least one skill is required"),
  skillGroups: z.array(partialSkillGroupSchema).optional(),
  certifications: z.array(partialCertificationSchema).optional(),
  projects: z.array(partialProjectSchema).optional(),
  languages: z.array(partialLanguageSchema).optional(),
  ...partialExtraSections,
});

export function validateCVContent(
  data: unknown,
  options?: { partial?: boolean }
): z.ZodSafeParseResult<CVContent> | z.ZodSafeParseResult<PartialCVContent> {
  if (options?.partial) {
    return generatedCVContentSchema.safeParse(data) as z.ZodSafeParseResult<PartialCVContent>;
  }
  return cvContentSchema.safeParse(data);
}

// Alternate AI response shape (see tailoring.rules.ts's ROLE COMPATIBILITY CHECK):
// returned instead of CVContent when the job description is a fundamentally
// different profession from the candidate's background, so the caller can
// show a clear "these are different roles" message instead of a hollow CV.
export const roleMismatchSchema = z.object({
  mismatch: z.literal(true),
  reason: z.string(),
  missing: z.array(z.string()).min(1),
});

export type RoleMismatch = z.infer<typeof roleMismatchSchema>;

export function isRoleMismatch(data: unknown): data is RoleMismatch {
  return roleMismatchSchema.safeParse(data).success;
}

// Structured clarification question — see clarification.rules.ts for when
// the model is instructed to produce these instead of guessing.
export const clarificationQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  type: z.enum(["text", "textarea", "select", "date"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;

// Present only when a job description was analyzed and the role was NOT a
// full mismatch (that case returns RoleMismatch instead). `gaps` lists
// specific job requirements the candidate's source material gives no
// evidence of — see tailoring.rules.ts's NO MATCH classification.
export const jobAnalysisSchema = z.object({
  mismatch: z.literal(false),
  gaps: z.array(z.string()).optional(),
});

export type JobAnalysis = z.infer<typeof jobAnalysisSchema>;

// The AI's normal (non-mismatch) response shape: analysis and generation
// share this — `candidateData` stays loosely partial here (analysis may run
// on sparse input, before any clarification round) — the stricter
// min-1-experience/skill gate is applied separately, only at persist time.
export const analyzeResultSchema = z.object({
  candidateData: PartialCVContent,
  questions: z.array(clarificationQuestionSchema).default([]),
  jobAnalysis: jobAnalysisSchema.nullable(),
});

export type AnalyzeResult = z.infer<typeof analyzeResultSchema>;
