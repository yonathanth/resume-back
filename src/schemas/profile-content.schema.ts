import { z } from "zod";
import {
  awardSchema,
  bulletObjectSchema,
  certificationSchema,
  courseSchema,
  educationEntrySchema,
  experienceEntrySchema,
  languageSchema,
  linkSchema,
  membershipSchema,
  personalDetailSchema,
  positionSchema,
  presentationSchema,
  projectSchema,
  publicationSchema,
  referenceSchema,
  volunteeringSchema,
} from "./cv-content.schema";

// A career profile's content: the CVContent sections (same field names, so a
// profile converts to a CV almost 1:1 — see services/profileContent.service.ts)
// minus contact details, which live on User and are shared by every profile.
// Every list item carries a stable `id` and provenance `meta`, which is what
// lets merges match items across updates and never overwrite user edits.

// Where an item's data came from. "manual" = typed into the profile editor;
// the rest are written back from CV flows.
export const PROFILE_ITEM_SOURCES = ["manual", "cv", "upload", "freestyle", "clarification", "enhance"] as const;
export type ProfileItemSource = (typeof PROFILE_ITEM_SOURCES)[number];

export const profileItemMetaSchema = z.object({
  source: z.enum(PROFILE_ITEM_SOURCES),
  sourceCvId: z.string().optional(),
  // True once the user edited the item by hand — automatic merges never
  // touch a locked item.
  locked: z.boolean(),
  // Earlier match keys of an item the user renamed, so a later merge still
  // recognizes it ("Backend Dev" at Acme edited to "Platform Engineer").
  aliases: z.array(z.string().max(400)).max(20).optional(),
  addedAt: z.string(),
  updatedAt: z.string().optional(),
});

export type ProfileItemMeta = z.infer<typeof profileItemMetaSchema>;

const MAX_ITEMS = 100;
const MAX_BULLETS = 30;
const MAX_SKILLS = 300;
const required = (label: string) => z.string().trim().min(1, `${label} is required`).max(300);

const profileBulletSchema = bulletObjectSchema.extend({
  id: z.string().max(64).optional(),
  text: z.string().trim().min(1).max(2_000),
});
const bullets = z.array(profileBulletSchema).max(MAX_BULLETS).default([]);

// Item field shapes, before id/meta are attached. Optional everywhere except
// the one or two fields that identify the item.
const ITEM_FIELDS = {
  links: linkSchema.partial().extend({ label: z.string().max(100).default(""), url: required("Link URL") }),
  experience: experienceEntrySchema.partial().extend({ company: required("Company"), role: required("Role"), bullets }),
  education: educationEntrySchema.partial().extend({ institution: required("Institution"), bullets }),
  projects: projectSchema.partial().extend({ name: required("Project name"), tech: z.array(z.string().max(100)).max(50).optional(), bullets }),
  certifications: certificationSchema.partial().extend({ name: required("Certification name") }),
  languages: languageSchema.partial().extend({ language: required("Language") }),
  awards: awardSchema.partial().extend({ title: required("Award title") }),
  publications: publicationSchema.partial().extend({ title: required("Publication title") }),
  volunteering: volunteeringSchema.partial().extend({ organization: required("Organization"), bullets }),
  courses: courseSchema.partial().extend({ name: required("Course name") }),
  memberships: membershipSchema.partial().extend({ organization: required("Organization") }),
  presentations: presentationSchema.partial().extend({ title: required("Presentation title") }),
  references: referenceSchema.partial().extend({ name: required("Reference name") }),
  personalDetails: personalDetailSchema.extend({ label: required("Label"), value: required("Value") }),
  research: positionSchema.partial().extend({ title: required("Title"), bullets }),
  teaching: positionSchema.partial().extend({ title: required("Title"), bullets }),
  activities: positionSchema.partial().extend({ title: required("Title"), bullets }),
  skills: z.object({ name: required("Skill").max(100) }),
  skillGroups: z.object({ category: required("Category"), items: z.array(z.string().trim().min(1).max(100)).max(100).default([]) }),
} as const;

export type ProfileSection = keyof typeof ITEM_FIELDS;
export const PROFILE_SECTIONS = Object.keys(ITEM_FIELDS) as ProfileSection[];

const scalarFields = {
  // The role headline CVs from this profile use (CVContent.personal.title).
  headline: z.string().trim().max(200).optional(),
  summary: z.string().trim().max(5_000).optional(),
  location: z.string().trim().max(200).optional(),
  interests: z.array(z.string().trim().min(1).max(100)).max(MAX_ITEMS).default([]),
};

// Spelled out per section (not built in a loop) so every section keeps its
// own inferred item type.
function storedSections() {
  const extras = { id: z.string().min(1).max(64), meta: profileItemMetaSchema };
  return {
    links: z.array(ITEM_FIELDS.links.extend(extras)).max(MAX_ITEMS).default([]),
    experience: z.array(ITEM_FIELDS.experience.extend(extras)).max(MAX_ITEMS).default([]),
    education: z.array(ITEM_FIELDS.education.extend(extras)).max(MAX_ITEMS).default([]),
    projects: z.array(ITEM_FIELDS.projects.extend(extras)).max(MAX_ITEMS).default([]),
    certifications: z.array(ITEM_FIELDS.certifications.extend(extras)).max(MAX_ITEMS).default([]),
    languages: z.array(ITEM_FIELDS.languages.extend(extras)).max(MAX_ITEMS).default([]),
    awards: z.array(ITEM_FIELDS.awards.extend(extras)).max(MAX_ITEMS).default([]),
    publications: z.array(ITEM_FIELDS.publications.extend(extras)).max(MAX_ITEMS).default([]),
    volunteering: z.array(ITEM_FIELDS.volunteering.extend(extras)).max(MAX_ITEMS).default([]),
    courses: z.array(ITEM_FIELDS.courses.extend(extras)).max(MAX_ITEMS).default([]),
    memberships: z.array(ITEM_FIELDS.memberships.extend(extras)).max(MAX_ITEMS).default([]),
    presentations: z.array(ITEM_FIELDS.presentations.extend(extras)).max(MAX_ITEMS).default([]),
    references: z.array(ITEM_FIELDS.references.extend(extras)).max(MAX_ITEMS).default([]),
    personalDetails: z.array(ITEM_FIELDS.personalDetails.extend(extras)).max(MAX_ITEMS).default([]),
    research: z.array(ITEM_FIELDS.research.extend(extras)).max(MAX_ITEMS).default([]),
    teaching: z.array(ITEM_FIELDS.teaching.extend(extras)).max(MAX_ITEMS).default([]),
    activities: z.array(ITEM_FIELDS.activities.extend(extras)).max(MAX_ITEMS).default([]),
    skills: z.array(ITEM_FIELDS.skills.extend(extras)).max(MAX_SKILLS).default([]),
    skillGroups: z.array(ITEM_FIELDS.skillGroups.extend(extras)).max(MAX_ITEMS).default([]),
  };
}

function inputSections() {
  const extras = { id: z.string().min(1).max(64).optional(), meta: z.unknown().optional() };
  return {
    links: z.array(ITEM_FIELDS.links.extend(extras)).max(MAX_ITEMS).default([]),
    experience: z.array(ITEM_FIELDS.experience.extend(extras)).max(MAX_ITEMS).default([]),
    education: z.array(ITEM_FIELDS.education.extend(extras)).max(MAX_ITEMS).default([]),
    projects: z.array(ITEM_FIELDS.projects.extend(extras)).max(MAX_ITEMS).default([]),
    certifications: z.array(ITEM_FIELDS.certifications.extend(extras)).max(MAX_ITEMS).default([]),
    languages: z.array(ITEM_FIELDS.languages.extend(extras)).max(MAX_ITEMS).default([]),
    awards: z.array(ITEM_FIELDS.awards.extend(extras)).max(MAX_ITEMS).default([]),
    publications: z.array(ITEM_FIELDS.publications.extend(extras)).max(MAX_ITEMS).default([]),
    volunteering: z.array(ITEM_FIELDS.volunteering.extend(extras)).max(MAX_ITEMS).default([]),
    courses: z.array(ITEM_FIELDS.courses.extend(extras)).max(MAX_ITEMS).default([]),
    memberships: z.array(ITEM_FIELDS.memberships.extend(extras)).max(MAX_ITEMS).default([]),
    presentations: z.array(ITEM_FIELDS.presentations.extend(extras)).max(MAX_ITEMS).default([]),
    references: z.array(ITEM_FIELDS.references.extend(extras)).max(MAX_ITEMS).default([]),
    personalDetails: z.array(ITEM_FIELDS.personalDetails.extend(extras)).max(MAX_ITEMS).default([]),
    research: z.array(ITEM_FIELDS.research.extend(extras)).max(MAX_ITEMS).default([]),
    teaching: z.array(ITEM_FIELDS.teaching.extend(extras)).max(MAX_ITEMS).default([]),
    activities: z.array(ITEM_FIELDS.activities.extend(extras)).max(MAX_ITEMS).default([]),
    skills: z.array(ITEM_FIELDS.skills.extend(extras)).max(MAX_SKILLS).default([]),
    skillGroups: z.array(ITEM_FIELDS.skillGroups.extend(extras)).max(MAX_ITEMS).default([]),
  };
}

/** Content as stored on CareerProfile.content — every item has id + meta. */
export const profileContentSchema = z.object({
  ...scalarFields,
  ...storedSections(),
  // "section:matchKey" of auto-added items the user deleted, so a later
  // merge doesn't quietly add them back.
  dismissedKeys: z.array(z.string().max(400)).max(2_000).default([]),
});

/**
 * Content as sent by the profile editor. ids are optional (new items have
 * none) and meta is ignored — the server owns both (see
 * services/profileContent.service.ts's applyManualEdit).
 */
export const profileContentInputSchema = z.object({
  ...scalarFields,
  ...inputSections(),
});

export type ProfileContent = z.infer<typeof profileContentSchema>;
export type ProfileContentInput = z.infer<typeof profileContentInputSchema>;

/** Generic view of any section item, for code that iterates over all sections. */
export type ProfileItem = { id: string; meta: ProfileItemMeta } & Record<string, unknown>;

export function emptyProfileContent(): ProfileContent {
  return profileContentSchema.parse({});
}

// Bounds the whole JSON document, independent of per-field limits.
export const MAX_PROFILE_CONTENT_CHARS = 400_000;
