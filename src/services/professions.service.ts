import { findOccupationByTitle } from "./occupation.service";

// A user's professions (User.professions): up to five, main one first.
// occupationTitle / occupationId mirror the first, so everything that reads a
// single profession (CV headline default, admin) keeps working.

export const MAX_PROFESSIONS = 5;
const MAX_LENGTH = 100;

/** Trimmed, de-duplicated (ignoring case), at most five; order kept. */
export function cleanProfessions(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const title = raw.trim().replace(/\s+/g, " ");
    const key = title.toLowerCase();
    if (!title || title.length > MAX_LENGTH || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length === MAX_PROFESSIONS) break;
  }
  return out;
}

/** `main` first, then the others it doesn't duplicate (changing the main profession keeps the rest). */
export function withMainProfession(main: string, current: string[]): string[] {
  return cleanProfessions([main, ...current]);
}

/**
 * Each title in the catalog's own wording when it matches an entry, plus the
 * first one's catalog id (for occupationId). Typed titles stay as typed.
 */
export async function resolveProfessions(titles: string[]): Promise<{ titles: string[]; mainOccupationId: string | null }> {
  const cleaned = cleanProfessions(titles);
  const matches = await Promise.all(cleaned.map((title) => findOccupationByTitle(title)));
  return {
    titles: cleanProfessions(cleaned.map((title, i) => matches[i]?.title ?? title)),
    mainOccupationId: matches[0]?.id ?? null,
  };
}
