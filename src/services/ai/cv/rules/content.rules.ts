/**
 * Writing-quality rules that apply regardless of enhancement level or
 * tailoring. The main goal: the CV must read like a strong candidate wrote it
 * carefully — specific and concrete — not like generic AI output.
 */

// Phrases that instantly mark text as generic or AI-written.
const BANNED_PHRASES = [
  "proven ability",
  "proven track record",
  "results-driven",
  "results-oriented",
  "detail-oriented",
  "highly motivated",
  "passionate about",
  "dynamic",
  "team player",
  "go-getter",
  "self-starter",
  "leveraged",
  "spearheaded",
  "synergy",
  "cutting-edge",
  "state-of-the-art",
  "robust",
  "seamless",
  "seamlessly",
  "innovative solutions",
  "drive functional solutions",
  "responsible for",
  "various",
  "a wide range of",
  "hands-on experience",
  "in a fast-paced environment",
  "ensuring high quality",
];

export function getContentRules(): string {
  return `CONTENT QUALITY RULES

SOUND HUMAN, BE SPECIFIC
Every sentence should contain something concrete: what was built, for whom, with which tools, how, and what it changed. If a sentence would fit any candidate's CV unchanged, rewrite it with this candidate's specifics.
Never use em dashes (—) anywhere in CV text or questions; use commas, colons, parentheses or separate sentences instead.
Never use these phrases (or close variants): ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}.
  Generic (bad): "Proven ability to manage client projects and drive functional solutions across frontend and backend technologies."
  Specific (good): "Ran client projects end to end (gathering requirements, planning sprints and demoing releases) while building the NestJS APIs and Next.js front ends behind them."

EXPERIENCE BULLETS
Structure: ACTION + WHAT + HOW/WITH WHAT + RESULT or PURPOSE.
  "Built the membership and check-in module for a gym management system in NestJS and PostgreSQL, replacing paper sign-in sheets for front-desk staff."
- 3–5 bullets for recent or target-relevant roles, 1–2 for older or unrelated ones, 2–4 per project, each covering a different aspect (building, integrating, leading, delivering, communicating).
- Start with a varied, precise verb (Built, Designed, Integrated, Shipped, Migrated, Automated, Mentored, Coordinated, Deployed, Refactored…). Don't reuse the same opening verb within a role.
- One line where possible, never more than two.

USE EVERY NUMBER THE CANDIDATE GAVE
Every figure in the material — counts, amounts, percentages, team sizes, durations, before/after values — must appear in the CV, attached to the work it describes, ideally in the bullet's result.
  Source: "I handled reconciliations for 40+ branch accounts and cut month-end closing from 6 days to 4."
  Good: "Reconciled 40+ branch accounts each month and cut month-end closing from 6 days to 4."

ORDER AND LENGTH
- List experience, education and projects in reverse chronological order (current or most recent first). Undated entries go where the candidate's description places them, otherwise after the dated ones.
- Aim for about one page of content for candidates with under ~7 years of experience, and never more than two pages' worth. Tighten wording and trim older roles before dropping anything recent.

SKILLS
List concrete skills: tools, software, methods, technical and domain skills, certifications. Soft skills ("communication", "leadership") only when the described work actually shows them — never as a generic filler list.

SUMMARY
Two to three sentences, first person implied (no "I"), no buzzwords. Say what the candidate does, their strongest concrete strengths (stack, domains, types of systems), and what they're aiming for. Specific over impressive-sounding.

CONSISTENCY
Keep dates, titles, company names, technologies and terminology consistent. Write proper names with their correct capitalization and standard spelling ("awash bank" → "Awash Bank", "excel" → "Excel", "addis ababa university" → "Addis Ababa University") without changing which organisation or tool is meant. Names you don't recognise (e.g. "Shalops") keep the candidate's spelling exactly. Leave out text that has no meaning (garbled characters, OCR noise, stray fragments) instead of carrying it into the CV. Present tense for current roles, past tense for previous ones. Never alter dates or chronology the candidate gave.`;
}
