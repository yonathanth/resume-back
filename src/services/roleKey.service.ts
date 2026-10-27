import { prisma } from "../db/client";

// Resolves a role title ("Sr. Back-end Dev") to a canonical role identity so
// a user has at most one career profile per role (CareerProfile's
// @@unique([userId, roleKey])). Deterministic and free — no AI involved:
//   1. normalize wording (case, punctuation, common abbreviations),
//   2. strip seniority into its own field,
//   3. snap to the Occupation catalog when the result is a catalog title.

// Level words that don't change which role it is. Compared against whole
// words after normalization; multi-word entries are matched as phrases.
const SENIORITY_TERMS: Record<string, string> = {
  "entry level": "junior",
  "mid level": "mid",
  senior: "senior",
  junior: "junior",
  lead: "lead",
  principal: "principal",
  staff: "staff",
  associate: "associate",
  intern: "intern",
  trainee: "intern",
  graduate: "junior",
  mid: "mid",
  i: "junior",
  ii: "mid",
  iii: "senior",
  iv: "senior",
};

// Abbreviations and spelling variants, applied word by word (after the
// phrase rewrites below).
const WORD_ALIASES: Record<string, string> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  jnr: "junior",
  dev: "developer",
  devs: "developer",
  eng: "engineer",
  engr: "engineer",
  mgr: "manager",
  mngr: "manager",
  admin: "administrator",
  sysadmin: "system administrator",
  swe: "software engineer",
  sde: "software engineer",
  pm: "product manager",
  ux: "ux",
  ui: "ui",
};

const PHRASE_ALIASES: [RegExp, string][] = [
  [/\bfront[\s-]?end\b/g, "frontend"],
  [/\bback[\s-]?end\b/g, "backend"],
  [/\bfull[\s-]?stack\b/g, "fullstack"],
  [/\bdev[\s-]?ops\b/g, "devops"],
  [/\bentry[\s-]level\b/g, "entry level"],
  [/\bmid[\s-]level\b/g, "mid level"],
  [/&/g, " and "],
];

export interface ResolvedRole {
  /** Canonical, unique-per-user role identity, e.g. "backend developer". */
  roleKey: string;
  /** Seniority stripped from the title, if any. */
  seniority: string | null;
  /** Set when the role matched an Occupation catalog title. */
  occupationId: string | null;
}

/** Lowercased words of a title with spelling variants and abbreviations expanded ("Sr. Back-end Dev" → senior backend developer). */
export function canonicalTitleWords(title: string): string[] {
  let text = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [pattern, replacement] of PHRASE_ALIASES) text = text.replace(pattern, replacement);
  text = text.replace(/[^a-z0-9+#\s]/g, " ");
  return text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (WORD_ALIASES[word] ?? word).split(" "));
}

export function normalizeRoleTitle(title: string): { base: string; seniority: string | null } {
  const words = canonicalTitleWords(title);

  let seniority: string | null = null;
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = `${words[i]} ${words[i + 1] ?? ""}`;
    if (SENIORITY_TERMS[pair]) {
      seniority ??= SENIORITY_TERMS[pair];
      i++;
      continue;
    }
    // Roman numerals only count as levels at the end ("Engineer II"), so
    // "I" never eats a leading word.
    const isNumeral = ["i", "ii", "iii", "iv"].includes(words[i]);
    if (SENIORITY_TERMS[words[i]] && (!isNumeral || i === words.length - 1) && words.length > 1) {
      seniority ??= SENIORITY_TERMS[words[i]];
      continue;
    }
    kept.push(words[i]);
  }

  return { base: kept.join(" "), seniority };
}

/** Pure part of resolveRole — normalizes and strips seniority, no catalog lookup. */
export function toRoleKey(title: string): { roleKey: string; seniority: string | null } {
  const { base, seniority } = normalizeRoleTitle(title);
  // A title made only of level words ("Senior") keeps its raw normalized form.
  const roleKey = (base || title.trim().toLowerCase()).slice(0, 200);
  return { roleKey, seniority };
}

/**
 * Full resolution. When `occupationId` is given (picked from the catalog in
 * the UI) it wins outright; otherwise the normalized title is snapped to a
 * catalog occupation whose own normalized title is identical.
 */
export async function resolveRole(title: string, occupationId?: string | null): Promise<ResolvedRole> {
  const { roleKey, seniority } = toRoleKey(title);

  if (occupationId) {
    const occupation = await prisma.occupation.findUnique({ where: { id: occupationId }, select: { id: true, title: true } });
    if (occupation) {
      return { roleKey: toRoleKey(occupation.title).roleKey, seniority, occupationId: occupation.id };
    }
  }

  const index = await getOccupationIndex();
  return { roleKey, seniority, occupationId: index.byRoleKey.get(roleKey) ?? null };
}

/** The catalog category of an occupation ("Software & Engineering"), from the cached index. */
export async function occupationCategory(occupationId: string | null | undefined): Promise<string | null> {
  if (!occupationId) return null;
  return (await getOccupationIndex()).categoryById.get(occupationId) ?? null;
}

// The catalog is small (a few hundred rows) and only changes with
// migrations, so it's indexed by roleKey in memory and refreshed now and then.
const OCCUPATION_INDEX_TTL_MS = 10 * 60 * 1000;
interface OccupationIndex {
  builtAt: number;
  byRoleKey: Map<string, string>;
  categoryById: Map<string, string>;
}
let occupationIndex: OccupationIndex | null = null;

async function getOccupationIndex(): Promise<OccupationIndex> {
  if (occupationIndex && Date.now() - occupationIndex.builtAt < OCCUPATION_INDEX_TTL_MS) {
    return occupationIndex;
  }
  const occupations = await prisma.occupation.findMany({ select: { id: true, title: true, category: true } });
  const byRoleKey = new Map<string, string>();
  const categoryById = new Map<string, string>();
  for (const o of occupations) {
    const key = toRoleKey(o.title).roleKey;
    if (!byRoleKey.has(key)) byRoleKey.set(key, o.id);
    categoryById.set(o.id, o.category);
  }
  occupationIndex = { builtAt: Date.now(), byRoleKey, categoryById };
  return occupationIndex;
}
