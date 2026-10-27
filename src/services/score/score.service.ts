import { createHash } from "node:crypto";
import { z } from "zod";
import { bulletText } from "../../utils/normalize-content";
import { getCVTemplate } from "../../config/cv-templates";
import type { JobRequirements, PolishCvInput, PolishCvResult, ScoreIssue } from "../ai/provider.interface";
import {
  SCORE_RULES_VERSION,
  scoreCv,
  textMentions,
  type CvScore,
  type PolishTarget,
  type ScoreInput,
} from "./engine";

export { SCORE_RULES_VERSION, scoreCv, type CvScore, type PolishTarget };

/** Same job description (ignoring surrounding and repeated whitespace) → same hash. */
export function hashJobDescription(jobDescription: string): string {
  return createHash("sha256").update(jobDescription.trim().replace(/\s+/g, " ")).digest("hex");
}

const jobRequirementsSchema = z.object({
  title: z.string(),
  seniority: z.string().default(""),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
  keywords: z.array(z.string()).default([]),
});

/** What CVDocument.jobRequirements holds. `data: null` marks text that isn't a job description, so it isn't re-sent to the AI. */
const storedJobAnalysisSchema = z.object({
  jdHash: z.string(),
  data: jobRequirementsSchema.nullable(),
});

export type StoredJobAnalysis = z.infer<typeof storedJobAnalysisSchema>;

/**
 * The stored analysis, but only when it was made from this exact job
 * description — a stale one (job description edited since) counts as none.
 */
export function currentJobAnalysis(jobDescription: string | null | undefined, stored: unknown): StoredJobAnalysis | null {
  if (!jobDescription?.trim()) return null;
  const parsed = storedJobAnalysisSchema.safeParse(stored);
  if (!parsed.success || parsed.data.jdHash !== hashJobDescription(jobDescription)) return null;
  return parsed.data;
}

/** The job requirements the score should use for this CV, if any. */
export function jobRequirementsFor(jobDescription: string | null | undefined, stored: unknown): JobRequirements | null {
  return currentJobAnalysis(jobDescription, stored)?.data ?? null;
}

/** A job description with nothing usable in it (the AI found no title and no skills). */
export function isEmptyJobAnalysis(data: JobRequirements): boolean {
  return !data.title.trim() && data.requiredSkills.length === 0 && data.preferredSkills.length === 0;
}

/** Scores content as its template shows it: half-filled entries only count in sections the template has. */
export function scoreContent(content: unknown, job: JobRequirements | null, templateId: string | null | undefined): CvScore {
  return scoreCv(content as ScoreInput, job, { sections: getCVTemplate(templateId).sections });
}

/** The score of a document's content against its (current) job analysis. */
export function scoreDocument(doc: { content: unknown; jobDescription: string | null; jobRequirements: unknown; templateId?: string | null }): CvScore {
  return scoreContent(doc.content, jobRequirementsFor(doc.jobDescription, doc.jobRequirements), doc.templateId);
}

/**
 * Adds score/scoreVersion to a document for a response. A document scored by
 * an older rules version (or never scored) is rescored on the fly, so every
 * screen shows the current rules' number even before the next save stores it.
 */
export function withCurrentScore<T extends { content: unknown; jobDescription: string | null; jobRequirements: unknown; templateId?: string | null; score: number | null; scoreVersion: string | null }>(
  doc: T
): T {
  if (doc.scoreVersion === SCORE_RULES_VERSION && doc.score !== null) return doc;
  return { ...doc, score: scoreDocument(doc).total, scoreVersion: SCORE_RULES_VERSION };
}

// ── Plain text for the AI ───────────────────────────────────────────────────

type Entry = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const entries = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter((e): e is Entry => !!e && typeof e === "object") : []);
const bullets = (v: unknown): string[] => (Array.isArray(v) ? v.map(bulletText).filter(Boolean) : []);

/**
 * The CV as plain text for review/polish prompts — the facts the AI must stay
 * within. Contact details (email, phone, links, photo) are left out: the AI
 * never needs them.
 */
export function cvPlainText(content: unknown): string {
  const cv = (content && typeof content === "object" ? content : {}) as Entry;
  const personal = (cv.personal && typeof cv.personal === "object" ? cv.personal : {}) as Entry;
  const lines: string[] = [];
  if (str(personal.title)) lines.push(`Headline: ${str(personal.title)}`);
  if (str(personal.location)) lines.push(`Location: ${str(personal.location)}`);
  if (str(cv.summary)) lines.push(`\nSUMMARY\n${str(cv.summary)}`);

  const experience = entries(cv.experience);
  if (experience.length) {
    lines.push("\nEXPERIENCE");
    experience.forEach((e, i) => {
      const dates = [str(e.start_date), str(e.end_date)].filter(Boolean).join(" – ");
      lines.push(`[${i}] ${str(e.role)} at ${str(e.company)}${dates ? ` (${dates})` : ""}`);
      for (const b of bullets(e.bullets)) lines.push(`- ${b}`);
    });
  }
  const education = entries(cv.education);
  if (education.length) {
    lines.push("\nEDUCATION");
    for (const e of education) {
      lines.push([str(e.degree), str(e.field), str(e.institution)].filter(Boolean).join(", "));
    }
  }
  const skills = Array.isArray(cv.skills) ? cv.skills.map(str).filter(Boolean) : [];
  if (skills.length) lines.push(`\nSKILLS\n${skills.join(", ")}`);
  const projects = entries(cv.projects);
  if (projects.length) {
    lines.push("\nPROJECTS");
    for (const p of projects) {
      const tech = Array.isArray(p.tech) ? p.tech.map(str).filter(Boolean) : [];
      lines.push(`${str(p.name)}${tech.length ? ` (${tech.join(", ")})` : ""}${str(p.description) ? `: ${str(p.description)}` : ""}`);
      for (const b of bullets(p.bullets)) lines.push(`- ${b}`);
    }
  }
  const certifications = entries(cv.certifications);
  if (certifications.length) {
    lines.push("\nCERTIFICATIONS");
    for (const c of certifications) lines.push([str(c.name), str(c.issuer)].filter(Boolean).join(", "));
  }
  return lines.join("\n").trim();
}

/** The checks that are losing points, as the AI prompts see them (worst first). */
export function failingIssues(score: CvScore, onlyFixable = false): ScoreIssue[] {
  return score.checks
    .filter((c) => c.status !== "pass" && (!onlyFixable || c.fix === "ai"))
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .map((c) => ({ label: c.label, message: c.message }));
}

// ── Polish ──────────────────────────────────────────────────────────────────

/** What the editor applies after a polish. Only the parts that were rewritten are present. */
export interface CvPolishPatch {
  summary?: string;
  headline?: string;
  experience?: { index: number; bullets: string[] }[];
  skillGroups?: { category: string; items: string[] }[];
}

/** Every fixable target of a score — what "Polish all" rewrites. */
export function allPolishTargets(score: CvScore): PolishTarget[] {
  const targets: PolishTarget[] = [];
  const seen = new Set<string>();
  for (const check of score.checks) {
    if (!check.polish || check.fix !== "ai") continue;
    // "Polish all" rewrites every role's bullets, so a role-specific target folds into it.
    const target: PolishTarget = check.polish.kind === "bullets" ? { kind: "bullets" } : check.polish;
    if (seen.has(target.kind)) continue;
    seen.add(target.kind);
    targets.push(target);
  }
  return targets;
}

const MAX_POLISHED_ROLES = 12;

/** Turns polish targets into the provider input: just the parts to rewrite, plus the facts and issues. */
export function buildPolishInput(content: unknown, targets: PolishTarget[], score: CvScore, job: JobRequirements | null): PolishCvInput {
  const cv = (content && typeof content === "object" ? content : {}) as Entry;
  const personal = (cv.personal && typeof cv.personal === "object" ? cv.personal : {}) as Entry;
  const experience = entries(cv.experience);
  const input: PolishCvInput = { cvText: cvPlainText(content), issues: failingIssues(score, true) };
  if (job) input.job = job;

  for (const target of targets) {
    if (target.kind === "summary") input.summary = str(cv.summary);
    if (target.kind === "headline") input.headline = str(personal.title);
    if (target.kind === "skills") {
      const groups = entries(cv.skillGroups).flatMap((g) => (Array.isArray(g.items) ? g.items.map(str) : []));
      input.skills = (groups.length ? groups : Array.isArray(cv.skills) ? cv.skills.map(str) : []).filter(Boolean);
    }
    if (target.kind === "bullets") {
      const indexes = target.index !== undefined ? [target.index] : experience.map((_, i) => i);
      const roles = input.roles ?? [];
      for (const index of indexes) {
        const role = experience[index];
        const existing = role ? bullets(role.bullets) : [];
        // A role without bullets has nothing to rewrite — the AI would have to invent them.
        if (!role || existing.length === 0 || roles.some((r) => r.index === index)) continue;
        roles.push({ index, role: str(role.role), company: str(role.company), bullets: existing });
      }
      input.roles = roles.slice(0, MAX_POLISHED_ROLES);
    }
  }
  return input;
}

const numbersIn = (text: string): string[] => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/** True when every number in `text` already appears somewhere in `facts` — a rewrite may not invent metrics. */
export function numbersAreGrounded(text: string, facts: string): boolean {
  const known = new Set(numbersIn(facts).map((n) => n.replace(/,/g, "")));
  return numbersIn(text).every((n) => known.has(n.replace(/,/g, "")));
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Server-side guard on an AI rewrite before the editor sees it:
 * - a part that introduces a number the CV never stated is dropped (kept as it was);
 * - a skill is kept only if the CV already lists or mentions it;
 * - only roles that exist and were asked for are touched, with sane bullet counts.
 */
export function sanitizePolish(content: unknown, input: PolishCvInput, result: PolishCvResult): CvPolishPatch {
  const facts = input.cvText;
  const patch: CvPolishPatch = {};

  if (input.summary !== undefined && result.summary) {
    const summary = oneLine(result.summary, 1200);
    if (summary && numbersAreGrounded(summary, facts)) patch.summary = summary;
  }

  if (input.headline !== undefined && result.headline) {
    const headline = oneLine(result.headline, 120);
    if (headline && numbersAreGrounded(headline, facts)) patch.headline = headline;
  }

  if (input.roles?.length && result.roles?.length) {
    const asked = new Map(input.roles.map((r) => [r.index, r]));
    const experience: CvPolishPatch["experience"] = [];
    for (const role of result.roles) {
      const original = asked.get(role.index);
      if (!original || experience.some((e) => e.index === role.index)) continue;
      const rewritten = role.bullets.map((b) => oneLine(b.replace(/^[-•*]\s*/, ""), 400)).filter(Boolean);
      // A rewrite may split long bullets but never balloons a role.
      const cap = Math.max(original.bullets.length + 2, 5);
      if (rewritten.length === 0 || rewritten.length > cap) continue;
      if (!rewritten.every((b) => numbersAreGrounded(b, original.bullets.join("\n") + "\n" + facts))) continue;
      experience.push({ index: role.index, bullets: rewritten });
    }
    if (experience.length) patch.experience = experience;
  }

  if (input.skills && result.skillGroups?.length) {
    const existing = new Set(input.skills.map((s) => s.toLowerCase()));
    const cv = (content && typeof content === "object" ? content : {}) as Entry;
    // Text the user wrote (not the skills list) — evidence a new skill is real.
    const evidence = [str(cv.summary), ...entries(cv.experience).flatMap((e) => bullets(e.bullets)), ...entries(cv.projects).flatMap((p) => [str(p.description), ...(Array.isArray(p.tech) ? p.tech.map(str) : []), ...bullets(p.bullets)])];
    const seen = new Set<string>();
    const groups: { category: string; items: string[] }[] = [];
    let total = 0;
    for (const group of result.skillGroups) {
      const items: string[] = [];
      for (const raw of group.items) {
        const skill = oneLine(raw, 60);
        const key = skill.toLowerCase();
        if (!skill || seen.has(key) || total >= 30) continue;
        if (!existing.has(key) && !textMentions(evidence, skill)) continue;
        seen.add(key);
        items.push(skill);
        total += 1;
      }
      if (items.length) groups.push({ category: oneLine(group.category, 60) || "Skills", items });
    }
    // Don't let a rewrite quietly drop most of the user's skills.
    const kept = [...seen].filter((k) => existing.has(k)).length;
    if (groups.length && kept >= Math.min(existing.size, 30) * 0.6) patch.skillGroups = groups;
  }

  return patch;
}

/** The content as it would be with the patch applied — for the projected score. */
export function applyPolishPatch(content: unknown, patch: CvPolishPatch): Record<string, unknown> {
  const cv = { ...((content && typeof content === "object" ? content : {}) as Entry) };
  if (patch.summary !== undefined) cv.summary = patch.summary;
  if (patch.headline !== undefined) cv.personal = { ...((cv.personal as Entry) ?? {}), title: patch.headline };
  if (patch.experience) {
    const experience = entries(cv.experience).map((e) => ({ ...e }));
    for (const { index, bullets: next } of patch.experience) {
      if (experience[index]) experience[index].bullets = next.map((text) => ({ text }));
    }
    cv.experience = experience;
  }
  if (patch.skillGroups) {
    cv.skillGroups = patch.skillGroups;
    cv.skills = patch.skillGroups.flatMap((g) => g.items);
  }
  return cv;
}
