import { randomUUID } from "node:crypto";
import type { PartialCVContent } from "../schemas/cv-content.schema";
import {
  PROFILE_SECTIONS,
  profileContentSchema,
  type ProfileContent,
  type ProfileContentInput,
  type ProfileItemMeta,
  type ProfileItemSource,
  type ProfileSection,
} from "../schemas/profile-content.schema";
import { toBullet } from "../utils/normalize-content";
import { canonicalTitleWords } from "./roleKey.service";
import { isEmptyValue, isPlainObject } from "../utils/merge-content";

// Everything that turns data into or out of a career profile's content —
// all deterministic (no AI), so creating, editing and merging a profile
// costs nothing beyond the database write.

/** Per-section counts of what a change did — powers change history and the consent card. */
export interface ProfileChangeSummary {
  added: Partial<Record<ProfileSection | "headline" | "summary" | "location" | "interests", number>>;
  updated: Partial<Record<ProfileSection, number>>;
  removed: Partial<Record<ProfileSection, number>>;
}

/**
 * One item of what a change does, for "see what changes": an item added, an
 * item gaining details (which empty fields get a value, which bullet points
 * are new), or an item the merge leaves alone on purpose — because the user
 * edited it (locked) or deleted it before (dismissed).
 */
export interface ProfileChangeDetail {
  section: ProfileSection | "headline" | "summary" | "location" | "interests";
  change: "added" | "updated" | "kept_edited" | "kept_removed";
  /** What the item is, e.g. "Backend Engineer" (experience) or "Python" (skill). */
  label: string;
  /** Where/what else, e.g. the company or school. */
  sublabel?: string;
  /** updated: the empty fields that get a value, by name ("start date", "location"). */
  filled?: string[];
  /** added/updated: the bullet points that are new. */
  newBullets?: string[];
  /** updated: new entries in a list field (project tools, skill group items). */
  newValues?: string[];
  /** headline / summary / location: the text that's filled in. */
  text?: string;
}

/** Enough to review; a CV rarely comes close. */
const MAX_DETAILS = 200;
const MAX_BULLETS_PER_DETAIL = 8;

const FIELD_NAMES: Record<string, string> = {
  start_date: "start date",
  end_date: "end date",
  field: "field of study",
  gpa: "grade",
  url: "link",
  tech: "tools",
  proficiency: "level",
};
const fieldName = (key: string) => FIELD_NAMES[key] ?? key.replace(/_/g, " ");

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A readable name for an item: its main field, and where it was. */
function itemLabel(section: ProfileSection, item: Record<string, unknown>): { label: string; sublabel?: string } {
  const pick = (...keys: string[]) => keys.map((k) => text(item[k])).find(Boolean) ?? "";
  const pair = (main: string, other: string) => (main ? { label: main, sublabel: other || undefined } : { label: other || "Item" });
  switch (section) {
    case "experience":
      return pair(pick("role"), pick("company"));
    case "education":
      return pair(pick("degree", "field"), pick("institution"));
    case "volunteering":
    case "memberships":
      return pair(pick("role"), pick("organization"));
    case "research":
    case "teaching":
    case "activities":
      return pair(pick("title"), pick("organization"));
    case "languages":
      return pair(pick("language"), pick("proficiency"));
    case "links":
      return pair(pick("label"), pick("url"));
    case "personalDetails":
      return pair(pick("label"), pick("value"));
    case "certifications":
      return pair(pick("name"), pick("issuer"));
    case "skillGroups":
      return pair(pick("category"), "");
    default:
      return pair(pick("name", "title"), "");
  }
}

type Bullet = { id?: string; label?: string; text: string };
type AnyItem = Record<string, unknown> & { id?: string; meta?: unknown; bullets?: Bullet[] };

const BULLET_SECTIONS = new Set<ProfileSection>(["experience", "education", "projects", "volunteering", "research", "teaching", "activities"]);
// Free-text fields that carry wording rather than facts — skipped when the
// source is a job-tailored CV (its wording was written for one job ad).
const PROSE_FIELDS = new Set(["bullets", "description", "subtitle"]);

function norm(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim() : "";
}

// Job titles compare by canonical words, so "Backend Dev" and "Back-end
// Developer" match. Seniority is kept: "Senior Engineer" at the same company
// is a promotion, i.e. a separate entry.
const roleNorm = (value: unknown) => (typeof value === "string" ? canonicalTitleWords(value).join(" ") : "");

/** What makes two items in a section "the same thing", independent of wording elsewhere. */
export function matchKey(section: ProfileSection, item: Record<string, unknown>): string {
  const parts: string[] = (() => {
    switch (section) {
      case "links": return [norm(item.url)];
      case "experience": return [norm(item.company), roleNorm(item.role)];
      case "education": return [norm(item.institution), norm(item.degree)];
      case "volunteering":
      case "memberships": return [norm(item.organization), roleNorm(item.role)];
      case "languages": return [norm(item.language)];
      case "personalDetails": return [norm(item.label)];
      case "skills": return [norm(item.name)];
      case "skillGroups": return [norm(item.category)];
      case "research":
      case "teaching":
      case "activities": return [roleNorm(item.title), norm(item.organization)];
      case "awards":
      case "publications":
      case "presentations": return [norm(item.title)];
      default: return [norm(item.name)];
    }
  })();
  return parts.join("|");
}

/** An item's current key plus any keys it had before the user renamed it. */
function itemKeys(section: ProfileSection, item: AnyItem): string[] {
  return [matchKey(section, item), ...((item.meta as ProfileItemMeta | undefined)?.aliases ?? [])];
}

const dismissKey = (section: ProfileSection, item: Record<string, unknown>) => `${section}:${matchKey(section, item)}`;

function newMeta(source: ProfileItemSource, now: string, extra: Partial<ProfileItemMeta> = {}): ProfileItemMeta {
  return { source, locked: source === "manual", addedAt: now, ...extra };
}

function withBulletIds<T extends AnyItem>(item: T): T {
  if (!Array.isArray(item.bullets)) return item;
  return { ...item, bullets: item.bullets.map((b) => (b.id ? b : { ...b, id: randomUUID() })) };
}

/** The item's own data, without id/meta — what "did this item change?" compares. */
function itemData(item: AnyItem): string {
  const { id: _id, meta: _meta, ...rest } = item;
  const bullets = Array.isArray(rest.bullets) ? rest.bullets.map(({ label, text }) => ({ label, text })) : rest.bullets;
  return JSON.stringify({ ...rest, bullets });
}

function sectionItems(content: Record<string, unknown>, section: ProfileSection): AnyItem[] {
  const value = content[section];
  return Array.isArray(value) ? (value as AnyItem[]) : [];
}

function bump(counts: Partial<Record<string, number>>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

export function isEmptySummary(summary: ProfileChangeSummary): boolean {
  return [summary.added, summary.updated, summary.removed].every((group) => Object.keys(group).length === 0);
}

/**
 * Applies a full-content save from the profile editor. The server owns ids
 * and meta: new items get fresh ids, changed items become locked (the user
 * edited them, so merges stop touching them), and deleting an item that was
 * added automatically records it in dismissedKeys so it isn't re-added.
 */
export function applyManualEdit(
  previous: ProfileContent,
  input: ProfileContentInput,
  now = new Date().toISOString()
): { content: ProfileContent; summary: ProfileChangeSummary } {
  const summary: ProfileChangeSummary = { added: {}, updated: {}, removed: {} };
  const dismissed = new Set(previous.dismissedKeys);
  const next: Record<string, unknown> = {
    headline: input.headline || undefined,
    summary: input.summary || undefined,
    location: input.location || undefined,
    interests: input.interests,
  };

  for (const section of PROFILE_SECTIONS) {
    const before = new Map(sectionItems(previous, section).map((item) => [item.id as string, item]));
    const kept = new Set<string>();

    next[section] = sectionItems(input, section).map((raw) => {
      const existing = raw.id ? before.get(raw.id) : undefined;
      const { meta: _ignored, ...data } = raw;
      if (existing) {
        kept.add(existing.id as string);
        const prevMeta = existing.meta as ProfileItemMeta;
        if (itemData(existing) === itemData(raw)) return withBulletIds({ ...data, id: existing.id, meta: prevMeta });
        bump(summary.updated, section);
        const oldKey = matchKey(section, existing);
        const aliases = oldKey !== matchKey(section, data) ? [...new Set([...(prevMeta.aliases ?? []), oldKey])].slice(-20) : prevMeta.aliases;
        return withBulletIds({ ...data, id: existing.id, meta: { ...prevMeta, locked: true, updatedAt: now, ...(aliases ? { aliases } : {}) } });
      }
      bump(summary.added, section);
      dismissed.delete(dismissKey(section, data));
      return withBulletIds({ ...data, id: randomUUID(), meta: newMeta("manual", now) });
    });

    for (const [id, item] of before) {
      if (kept.has(id)) continue;
      bump(summary.removed, section);
      if ((item.meta as ProfileItemMeta).source !== "manual") dismissed.add(dismissKey(section, item));
    }
  }

  next.dismissedKeys = Array.from(dismissed);
  return { content: profileContentSchema.parse(next), summary };
}

/** Fresh ids for every item — used when copying one profile's content into a new one. */
export function cloneProfileContent(content: ProfileContent, now = new Date().toISOString()): ProfileContent {
  const next: Record<string, unknown> = { ...content, dismissedKeys: [] };
  for (const section of PROFILE_SECTIONS) {
    next[section] = sectionItems(content, section).map((item) =>
      withBulletIds({
        ...item,
        id: randomUUID(),
        meta: { ...(item.meta as ProfileItemMeta), addedAt: now },
        bullets: Array.isArray(item.bullets) ? item.bullets.map(({ id: _id, ...b }) => b) : item.bullets,
      })
    );
  }
  return profileContentSchema.parse(next);
}

export interface CvToProfileOptions {
  source: ProfileItemSource;
  sourceCvId?: string;
  /**
   * False when the CV was tailored to a job description: its facts (roles,
   * dates, skills, schools) are kept but its wording (bullets, summary,
   * descriptions) is not, so one job ad's phrasing never becomes the
   * profile's truth.
   */
  includeProse: boolean;
}

/** Converts CV content into profile content (ids + meta attached). Contact details are dropped. */
export function cvContentToProfileContent(cv: PartialCVContent, options: CvToProfileOptions, now = new Date().toISOString()): ProfileContent {
  const meta = () => newMeta(options.source, now, options.sourceCvId ? { sourceCvId: options.sourceCvId } : {});
  const cvRecord = cv as Record<string, unknown>;
  const next: Record<string, unknown> = {
    headline: cv.personal?.title || undefined,
    summary: options.includeProse ? cv.summary || undefined : undefined,
    location: cv.personal?.location || undefined,
    interests: (cv.interests ?? []).filter((i) => i.trim()),
  };

  const toItem = (raw: unknown): AnyItem | null => {
    if (!isPlainObject(raw)) return null;
    const item: AnyItem = {};
    for (const [key, value] of Object.entries(raw)) {
      if (isEmptyValue(value)) continue;
      if (!options.includeProse && PROSE_FIELDS.has(key)) continue;
      item[key] = key === "bullets" && Array.isArray(value) ? value.map(toBullet).filter(Boolean) : value;
    }
    return withBulletIds({ ...item, id: randomUUID(), meta: meta() });
  };

  for (const section of PROFILE_SECTIONS) {
    let raw: unknown[];
    if (section === "skills") raw = (cv.skills ?? []).map((name) => ({ name }));
    else if (section === "links") raw = cv.personal?.links ?? [];
    else raw = Array.isArray(cvRecord[section]) ? (cvRecord[section] as unknown[]) : [];

    const items = raw.map(toItem).filter((item): item is AnyItem => item !== null);
    // Items missing their identifying field (e.g. an experience with no
    // company) are dropped rather than failing the whole conversion.
    next[section] = items.filter((item) => matchKey(section, item).replace(/\|/g, "").length > 0 && hasRequiredFields(section, item));
    if (BULLET_SECTIONS.has(section)) {
      next[section] = (next[section] as AnyItem[]).map((item) => ({ ...item, bullets: item.bullets ?? [] }));
    }
  }

  return profileContentSchema.parse(next);
}

function hasRequiredFields(section: ProfileSection, item: AnyItem): boolean {
  switch (section) {
    case "experience": return !isEmptyValue(item.company) && !isEmptyValue(item.role);
    case "personalDetails": return !isEmptyValue(item.label) && !isEmptyValue(item.value);
    default: return true;
  }
}

// Two bullets are "the same" when most of their words overlap — catches
// small rewordings without any AI call.
function similarBullets(a: string, b: string): boolean {
  const wa = new Set(norm(a).split(" ").filter(Boolean));
  const wb = new Set(norm(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared) >= 0.8;
}

/**
 * Merges incoming content (from a CV) into an existing profile. Rules:
 * - items match by matchKey; unmatched items are appended unless the user
 *   previously deleted them (dismissedKeys),
 * - matched items that the user locked are left exactly as they are,
 * - matched unlocked items only gain data: empty fields are filled and new
 *   bullets appended — nothing is ever overwritten or removed,
 * - headline/summary/location are filled only when empty.
 */
export function mergeProfileContent(
  base: ProfileContent,
  incoming: ProfileContent,
  now = new Date().toISOString()
): { content: ProfileContent; summary: ProfileChangeSummary; details: ProfileChangeDetail[] } {
  const summary: ProfileChangeSummary = { added: {}, updated: {}, removed: {} };
  const details: ProfileChangeDetail[] = [];
  const note = (detail: ProfileChangeDetail) => {
    if (details.length < MAX_DETAILS) details.push(detail);
  };
  const dismissed = new Set(base.dismissedKeys);
  const next: Record<string, unknown> = { ...base };

  for (const field of ["headline", "summary", "location"] as const) {
    if (isEmptyValue(base[field]) && !isEmptyValue(incoming[field])) {
      next[field] = incoming[field];
      bump(summary.added, field);
      note({ section: field, change: "added", label: field[0].toUpperCase() + field.slice(1), text: text(incoming[field]) });
    }
  }

  const interests = new Map(base.interests.map((i) => [norm(i), i]));
  for (const interest of incoming.interests) {
    if (!interests.has(norm(interest))) {
      interests.set(norm(interest), interest);
      bump(summary.added, "interests");
      note({ section: "interests", change: "added", label: interest });
    }
  }
  next.interests = Array.from(interests.values());

  for (const section of PROFILE_SECTIONS) {
    const items = sectionItems(base, section).map((item) => ({ ...item }));
    const byKey = new Map<string, AnyItem>();
    for (const item of items) for (const key of itemKeys(section, item)) if (!byKey.has(key)) byKey.set(key, item);

    for (const candidate of sectionItems(incoming, section)) {
      const key = matchKey(section, candidate);
      if (dismissed.has(`${section}:${key}`)) {
        note({ section, change: "kept_removed", ...itemLabel(section, candidate) });
        continue;
      }

      const existing = byKey.get(key);
      if (!existing) {
        const added = { ...candidate, meta: { ...(candidate.meta as ProfileItemMeta), addedAt: now } };
        items.push(added);
        byKey.set(key, added);
        bump(summary.added, section);
        const bulletTexts = ((candidate.bullets ?? []) as Bullet[]).map((b) => b.text).filter(Boolean);
        note({
          section,
          change: "added",
          ...itemLabel(section, candidate),
          ...(bulletTexts.length > 0 && { newBullets: bulletTexts.slice(0, MAX_BULLETS_PER_DETAIL) }),
        });
        continue;
      }
      if ((existing.meta as ProfileItemMeta).locked) {
        // Left exactly as the user edited it — said so only when the CV had something it would have added.
        if (fillItem(section, structuredClone(existing), candidate).changed) note({ section, change: "kept_edited", ...itemLabel(section, existing) });
        continue;
      }
      const filled = fillItem(section, existing, candidate);
      if (filled.changed) {
        existing.meta = { ...(existing.meta as ProfileItemMeta), updatedAt: now };
        bump(summary.updated, section);
        note({
          section,
          change: "updated",
          ...itemLabel(section, existing),
          ...(filled.fields.length > 0 && { filled: filled.fields.map(fieldName) }),
          ...(filled.bullets.length > 0 && { newBullets: filled.bullets.slice(0, MAX_BULLETS_PER_DETAIL) }),
          ...(filled.values.length > 0 && { newValues: filled.values }),
        });
      }
    }
    next[section] = items;
  }

  return { content: profileContentSchema.parse(next), summary, details };
}

/**
 * Fills empty fields and appends new bullets/list values on `target` in
 * place. Returns whether anything changed, and what: the fields filled, the
 * new bullet texts and the new list values.
 */
function fillItem(
  section: ProfileSection,
  target: AnyItem,
  source: AnyItem
): { changed: boolean; fields: string[]; bullets: string[]; values: string[] } {
  const fields: string[] = [];
  const bullets: string[] = [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === "id" || key === "meta" || isEmptyValue(value)) continue;

    if (key === "bullets" && Array.isArray(value)) {
      const current = (target.bullets ?? []) as Bullet[];
      const fresh = (value as Bullet[]).filter((b) => !current.some((c) => similarBullets(c.text, b.text)));
      if (fresh.length > 0) {
        target.bullets = [...current, ...fresh];
        bullets.push(...fresh.map((b) => b.text));
      }
    } else if (Array.isArray(value) && Array.isArray(target[key])) {
      // String lists (project tech, skill group items): union.
      const current = target[key] as string[];
      const seen = new Set(current.map(norm));
      const fresh = (value as string[]).filter((v) => typeof v === "string" && !seen.has(norm(v)));
      if (fresh.length > 0) {
        target[key] = [...current, ...fresh];
        values.push(...fresh);
      }
    } else if (isEmptyValue(target[key])) {
      target[key] = value;
      fields.push(key);
    }
  }
  const changed = (fields.length > 0 || bullets.length > 0 || values.length > 0) && section !== "skills";
  return { changed, fields, bullets, values };
}

/**
 * Profile content → CVContent shape, for generating a CV from a profile.
 * Contact details come from the account (see profileDefaults.service.ts).
 */
export function profileContentToCvContent(
  content: ProfileContent,
  contact: { full_name?: string; email?: string; phone?: string } = {}
): PartialCVContent {
  const strip = (items: AnyItem[]) =>
    items.map(({ id: _id, meta: _meta, ...rest }) =>
      Array.isArray(rest.bullets) ? { ...rest, bullets: (rest.bullets as Bullet[]).map(({ label, text }) => (label ? { label, text } : { text })) } : rest
    );

  const cv: Record<string, unknown> = {
    personal: {
      full_name: contact.full_name ?? "",
      email: contact.email ?? "",
      ...(contact.phone ? { phone: contact.phone } : {}),
      title: content.headline ?? "",
      ...(content.location ? { location: content.location } : {}),
      ...(content.links.length ? { links: content.links.map(({ label, url }) => ({ label, url })) } : {}),
    },
    ...(content.summary ? { summary: content.summary } : {}),
    skills: content.skills.map((s) => s.name),
    ...(content.interests.length ? { interests: content.interests } : {}),
  };
  for (const section of PROFILE_SECTIONS) {
    if (section === "skills" || section === "links") continue;
    const items = sectionItems(content, section);
    if (items.length > 0 || section === "experience" || section === "education") cv[section] = strip(items);
  }
  return cv as PartialCVContent;
}

/** Item counts per non-empty section, for profile list cards. */
export function countProfileContent(content: ProfileContent): Partial<Record<ProfileSection, number>> {
  const counts: Partial<Record<ProfileSection, number>> = {};
  for (const section of PROFILE_SECTIONS) {
    const n = sectionItems(content, section).length;
    if (n > 0) counts[section] = n;
  }
  return counts;
}

/**
 * Parses stored JSON (filling defaults for sections added since it was
 * written). Throws on invalid content rather than falling back to empty —
 * a silent fallback would let the next save wipe the user's data.
 */
export function readProfileContent(value: unknown): ProfileContent {
  return profileContentSchema.parse(value);
}

// ---------------------------------------------------------------- wording (Enhance)

/** One "use the improved wording?" offer: an entry's (or the summary's) current text vs the improved text. */
export interface WordingProposal {
  /** "summary", or "<section>:<profile item id>". */
  key: string;
  section: ProfileSection | "summary";
  /** The profile entry, e.g. "Backend Developer · Acme". */
  label: string;
  before: string[];
  after: string[];
  /** The user edited this entry by hand earlier — replacing it is their call. */
  locked: boolean;
  /** The improved bullets with their structure (label/text) — what gets saved. Server-side only. */
  afterBullets?: Bullet[];
}

const bulletLines = (bullets: unknown): string[] =>
  Array.isArray(bullets) ? (bullets as Bullet[]).map((b) => (b.label ? `${b.label}: ${b.text}` : b.text)).filter(Boolean) : [];
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => norm(line) === norm(b[i]));

function proposalLabel(section: ProfileSection, item: AnyItem): string {
  const parts = [item.role ?? item.title ?? item.name ?? item.institution ?? item.organization, item.company ?? item.organization]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return [...new Set(parts)].join(" · ") || section;
}

/**
 * Where improved CV wording differs from what the profile holds, entry by
 * entry. Only entries the profile already has are offered — new entries are
 * facts, which go through mergeProfileContent instead.
 */
export function wordingProposals(profile: ProfileContent, improved: ProfileContent): WordingProposal[] {
  const proposals: WordingProposal[] = [];
  if (improved.summary && profile.summary && norm(improved.summary) !== norm(profile.summary)) {
    proposals.push({ key: "summary", section: "summary", label: "Professional summary", before: [profile.summary], after: [improved.summary], locked: false });
  }
  for (const section of PROFILE_SECTIONS) {
    if (!BULLET_SECTIONS.has(section)) continue;
    const items = sectionItems(profile, section);
    for (const candidate of sectionItems(improved, section)) {
      const after = bulletLines(candidate.bullets);
      if (after.length === 0) continue;
      const keys = new Set(itemKeys(section, candidate));
      const existing = items.find((item) => itemKeys(section, item).some((k) => keys.has(k)));
      if (!existing) continue;
      const before = bulletLines(existing.bullets);
      if (sameLines(before, after)) continue;
      proposals.push({
        key: `${section}:${existing.id}`,
        section,
        label: proposalLabel(section, existing),
        before,
        after,
        locked: Boolean((existing.meta as ProfileItemMeta).locked),
        afterBullets: (candidate.bullets ?? []).map(({ label, text }) => (label ? { label, text } : { text })),
      });
    }
  }
  return proposals;
}

/**
 * Applies the approved proposals. Approved wording becomes the user's own:
 * the entry is marked locked (source "enhance") so later merges leave it be.
 */
export function applyWording(
  profile: ProfileContent,
  improved: ProfileContent,
  approvedKeys: string[],
  now = new Date().toISOString()
): { content: ProfileContent; summary: ProfileChangeSummary; applied: number } {
  const approved = new Set(approvedKeys);
  const proposals = wordingProposals(profile, improved).filter((p) => approved.has(p.key));
  const summary: ProfileChangeSummary = { added: {}, updated: {}, removed: {} };
  const next: Record<string, unknown> = { ...profile };

  for (const proposal of proposals) {
    if (proposal.section === "summary") {
      next.summary = proposal.after[0];
      bump(summary.updated, "summary" as ProfileSection);
      continue;
    }
    const section = proposal.section;
    const itemId = proposal.key.slice(section.length + 1);
    next[section] = sectionItems(next, section).map((item) => {
      if (item.id !== itemId) return item;
      bump(summary.updated, section);
      return {
        ...item,
        bullets: (proposal.afterBullets ?? []).map((bullet) => ({ ...bullet, id: randomUUID() })),
        meta: { ...(item.meta as ProfileItemMeta), source: "enhance", locked: true, updatedAt: now },
      };
    });
  }
  return { content: profileContentSchema.parse(next), summary, applied: proposals.length };
}
