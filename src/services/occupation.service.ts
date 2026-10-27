import { prisma } from "../db/client";

export interface OccupationSuggestion {
  id: string;
  title: string;
  category: string;
}

const MAX_LIMIT = 20;
// Candidates fetched before ranking — the catalog is small, so this comfortably
// covers every plausible match for a short query.
const CANDIDATE_POOL = 60;

/**
 * Typeahead search over the occupation catalog. Titles that start with the
 * query rank first, then titles with a word starting with it, then titles
 * containing it, then keyword-only matches — so "dev" suggests "DevOps
 * Engineer", then "Frontend Developer", then "Software Engineer" (keyword).
 */
export async function searchOccupations(query: string, limit = 8): Promise<OccupationSuggestion[]> {
  const q = query.trim();
  const take = Math.min(Math.max(limit, 1), MAX_LIMIT);

  if (!q) {
    return prisma.occupation.findMany({
      select: { id: true, title: true, category: true },
      orderBy: { title: "asc" },
      take,
    });
  }

  const candidates = await prisma.occupation.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { keywords: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, category: true, keywords: true },
    take: CANDIDATE_POOL,
  });

  const needle = q.toLowerCase();
  const rank = (o: { title: string; keywords: string }) => {
    const title = o.title.toLowerCase();
    if (title === needle) return 0;
    if (title.startsWith(needle)) return 1;
    if (title.split(/[\s/-]+/).some((word) => word.startsWith(needle))) return 2;
    if (title.includes(needle)) return 3;
    if (o.keywords.toLowerCase().split(" ").some((word) => word.startsWith(needle))) return 4;
    return 5;
  };

  return candidates
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    .slice(0, take)
    .map(({ id, title, category }) => ({ id, title, category }));
}

/** Exact, case-insensitive catalog match for a typed title (so a typed "data analyst" links to the catalog row). */
export function findOccupationByTitle(title: string) {
  return prisma.occupation.findFirst({ where: { title: { equals: title.trim(), mode: "insensitive" } } });
}
