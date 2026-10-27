import { findPhoneNumbersInText } from "libphonenumber-js";
import type { Prisma } from "@prisma/client";

/**
 * Best-effort guesses at the unambiguous contact fields only. Structuring
 * the rest of the CV is the AI step's job — don't extend this with regex
 * parsing of experience/education/skills.
 */

const EMAIL_REGEX = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

// A loose run of digits and separators; validated by digit count below.
const LOOSE_PHONE_REGEX = /(?<![\w/])\+?\(?\d[\d\s().-]{6,}\d(?![\w/])/g;
// Year ranges ("2018 - 2022", "2018–2022 2022–2024") look like phone numbers.
const YEAR_RANGES_REGEX = /^(?:(?:19|20)\d{2}\s*[-–.\s]\s*)+(?:19|20)\d{2}$/;

const PROFILE_DOMAINS: [RegExp, string][] = [
  [/linkedin\.com/i, "LinkedIn"],
  [/github\.com/i, "GitHub"],
  [/gitlab\.com/i, "GitLab"],
  [/behance\.net/i, "Behance"],
  [/dribbble\.com/i, "Dribbble"],
  [/stackoverflow\.com/i, "Stack Overflow"],
  [/medium\.com/i, "Medium"],
  [/(?:twitter|x)\.com/i, "X"],
];
const URL_REGEX =
  /\b(?:https?:\/\/|www\.)[^\s()<>|,"']+|\b(?:linkedin\.com\/in|github\.com|gitlab\.com|behance\.net|dribbble\.com)\/[^\s()<>|,"']+/gi;

// Words that mark a line as a heading or a job title rather than a name.
const NOT_A_NAME =
  /\b(curriculum|vitae|resume|résumé|cv|profile|summary|contact|experience|education|skills|engineer|developer|manager|designer|analyst|consultant|specialist|officer|director|intern|student|assistant|architect|scientist|accountant|teacher|nurse|technician|coordinator|administrator|senior|junior|lead|head|freelance)\b/i;
const NAME_PARTICLES = /^(?:van|von|der|den|de|del|della|di|da|dos|du|la|le|bin|binti|ibn|al|el|y|e)$/i;

/** Everything before a References section — referees' contact details aren't the candidate's. */
function candidateSection(text: string): string {
  const refs = text.search(/^\s*(?:references|referees)\b/im);
  return refs > 0 ? text.slice(0, refs) : text;
}

function looksLikeName(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  if (/[\d@/:|•,]/.test(trimmed) || NOT_A_NAME.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => NAME_PARTICLES.test(word) || /^\p{Lu}[\p{L}'’.-]*$/u.test(word));
}

function tidyName(line: string): string {
  const name = line.trim().replace(/\s+/g, " ");
  // "JOHN SMITH" → "John Smith"; mixed case is left as the person wrote it.
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function guessName(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
  const line = lines.find(looksLikeName);
  return line ? tidyName(line) : undefined;
}

export function guessEmail(text: string): string | undefined {
  const match = candidateSection(text).match(EMAIL_REGEX)?.[0];
  return match?.replace(/\.$/, "").toLowerCase();
}

export function guessPhone(text: string): string | undefined {
  const section = candidateSection(text);

  // Numbers written with a country code can be validated properly.
  const international = findPhoneNumbersInText(section)[0];
  if (international) return section.slice(international.startsAt, international.endsAt).trim();

  // Without one there's no country to validate against, so accept a
  // plausible digit count and keep it as written.
  for (const match of section.matchAll(LOOSE_PHONE_REGEX)) {
    const candidate = match[0].trim();
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (YEAR_RANGES_REGEX.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}

export function guessLinks(text: string): { label: string; url: string }[] {
  const section = candidateSection(text);
  const contactArea = section.split("\n").slice(0, 25).join("\n");
  const links = new Map<string, { label: string; url: string }>();

  for (const raw of section.match(URL_REGEX) ?? []) {
    const cleaned = raw.replace(/[.,;:!?)\]]+$/, "");
    const url = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    const label = PROFILE_DOMAINS.find(([pattern]) => pattern.test(url))?.[1];
    // Other URLs only count as the candidate's own (a portfolio) when they
    // sit with the contact details, not in an employer or project line.
    if (!label && !contactArea.includes(raw)) continue;
    const key = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    if (!links.has(key)) links.set(key, { label: label ?? "Website", url });
  }
  return [...links.values()];
}

/**
 * @param uncertainWords OCR'd words read with low confidence. A field built
 * from one is left out: the email in particular is pinned as authoritative
 * downstream, and "jose@example.cam" is worse than no email at all.
 */
export function guessExtractedData(text: string, uncertainWords: string[] = []): Prisma.JsonObject {
  const uncertain = uncertainWords.filter((word) => word.length >= 2);
  const trusted = <T extends string>(value: T | undefined): T | undefined =>
    value && !uncertain.some((word) => value.includes(word)) ? value : undefined;

  const personal: Prisma.JsonObject = {};
  const fullName = trusted(guessName(text));
  const email = trusted(guessEmail(text));
  const phone = trusted(guessPhone(text));
  const links = guessLinks(text).filter((link) => trusted(link.url));
  if (fullName) personal.full_name = fullName;
  if (email) personal.email = email;
  if (phone) personal.phone = phone;
  if (links.length) personal.links = links;
  return Object.keys(personal).length > 0 ? { personal } : {};
}
