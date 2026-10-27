// Surname particles that stay lower case unless they start the name.
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "la", "le", "bin", "binti", "al", "el"]);

/**
 * Capitalises a person's name the way it should appear on a CV. Only words
 * typed entirely in lower or upper case are changed ("yonathan" → "Yonathan",
 * "TENAYE" → "Tenaye"); mixed-case words are kept as the person wrote them
 * ("McDonald", "DeShawn"), and particles like "van der" stay lower case
 * after the first word.
 */
export function formatPersonName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word, i) => {
      if (word !== word.toLowerCase() && word !== word.toUpperCase()) return word;
      const lower = word.toLowerCase();
      if (i > 0 && PARTICLES.has(lower)) return lower;
      // Capitalise each part of hyphenated/apostrophe names: "jean-paul", "o'neil".
      return lower.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
    })
    .join(" ");
}
