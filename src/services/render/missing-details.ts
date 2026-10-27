/**
 * Editor-preview placeholders for missing details. In the live preview only
 * (never the PDF or thumbnails), every section the template shows but the CV
 * leaves empty gets a sample entry, and existing entries get their missing
 * key fields — all as placeholder text the editor highlights and makes
 * clickable ("Job title", "Company"...). The CV itself is never changed.
 *
 * Placeholders travel through the normal templates as ordinary text wrapped
 * in private-use marker characters, so every template renders them in its
 * own layout with no template changes. markMissingDetails() then turns the
 * markers into <span class="cv-missing" data-missing="section">.
 *
 * The frontend mirrors these rules (lib/missing-details.ts) to list what's
 * missing; keep the two in step.
 */
import type { CVSectionKey } from "../../config/cv-sections";
import { PATH_MARKED } from "./content-paths";

const OPEN = "";
const SEP = "";
const CLOSE = "";

type Content = Record<string, unknown>;

/** Placeholder text for `section`. Each word is marked separately so helpers that split names still work. */
function missing(section: string, text: string): string {
  return text
    .split(" ")
    .map((word) => `${OPEN}${section}${SEP}${word}${CLOSE}`)
    .join(" ");
}

const has = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
const asItems = (value: unknown): Content[] =>
  Array.isArray(value) ? value.filter((v): v is Content => typeof v === "object" && v !== null) : [];

/** A sample entry for each section shown while it's empty. */
function emptySection(key: CVSectionKey): Content | null {
  const m = (text: string) => missing(key, text);
  const position = { title: m("Title"), organization: m("Organization"), start_date: m("Start"), end_date: m("End") };
  switch (key) {
    case "summary":
      return { summary: m("Add a short professional summary") };
    case "experience":
      return {
        experience: [
          { role: m("Job title"), company: m("Company"), start_date: m("Start"), end_date: m("End"), bullets: [{ text: m("What you did and the result") }] },
        ],
      };
    case "education":
      return { education: [{ institution: m("School or university"), degree: m("Degree"), end_date: m("Graduation") }] };
    case "projects":
      return { projects: [{ name: m("Project name"), bullets: [{ text: m("What you built and the result") }] }] };
    case "skills":
      return { skillGroups: [{ category: "", items: [m("Add your skills")] }] };
    case "certifications":
      return { certifications: [{ name: m("Certification"), issuer: m("Issuer"), date: m("Date") }] };
    case "languages":
      return { languages: [{ language: m("Language"), proficiency: m("Level") }] };
    case "awards":
      return { awards: [{ title: m("Award"), issuer: m("Issuer"), date: m("Date") }] };
    case "publications":
      return { publications: [{ title: m("Publication title"), venue: m("Journal or conference"), date: m("Year") }] };
    case "volunteering":
      return { volunteering: [{ organization: m("Organization"), role: m("Role"), start_date: m("Start"), end_date: m("End") }] };
    case "courses":
      return { courses: [{ name: m("Course"), institution: m("Institution"), date: m("Date") }] };
    case "memberships":
      return { memberships: [{ organization: m("Organization"), role: m("Role") }] };
    case "presentations":
      return { presentations: [{ title: m("Talk title"), event: m("Event"), date: m("Date") }] };
    case "interests":
      return { interests: [m("Add your interests")] };
    case "references":
      return { references: [{ name: m("Reference name"), title: m("Job title"), organization: m("Organization") }] };
    case "personalDetails":
      return { personalDetails: [{ label: m("Detail"), value: m("Value") }] };
    case "research":
    case "teaching":
    case "activities":
      return { [key]: [position] };
    default:
      return null; // photo and consent are never prompted for
  }
}

function sectionIsEmpty(key: CVSectionKey, content: Content): boolean {
  switch (key) {
    case "summary":
      return !has(content.summary);
    case "skills":
      return (
        !asItems(content.skillGroups).some((g) => Array.isArray(g.items) && g.items.length > 0) &&
        !(Array.isArray(content.skills) && content.skills.some(has))
      );
    case "interests":
      return !(Array.isArray(content.interests) && content.interests.some(has));
    default:
      return asItems(content[key]).length === 0;
  }
}

/** Key fields of an existing entry, filled when blank: [field, placeholder]. */
const ENTRY_FIELDS: Partial<Record<CVSectionKey, [string, string][]>> = {
  experience: [
    ["role", "Job title"],
    ["company", "Company"],
  ],
  education: [
    ["institution", "School or university"],
    ["degree", "Degree"],
  ],
  projects: [["name", "Project name"]],
  certifications: [["name", "Certification"]],
  languages: [
    ["language", "Language"],
    ["proficiency", "Level"],
  ],
  awards: [["title", "Award"]],
  publications: [["title", "Publication title"]],
  volunteering: [["organization", "Organization"]],
  courses: [["name", "Course"]],
  memberships: [["organization", "Organization"]],
  presentations: [["title", "Talk title"]],
  references: [["name", "Reference name"]],
  research: [["title", "Title"]],
  teaching: [["title", "Title"]],
  activities: [["title", "Title"]],
};

// Dated sections: an entry with neither date gets both as placeholders.
const DATED: CVSectionKey[] = ["experience", "volunteering", "research", "teaching", "activities"];

// Sections whose entries read as unfinished without bullet points (a
// project's one-line description counts as content).
const BULLETED: CVSectionKey[] = ["experience", "projects"];
const BULLET_PLACEHOLDER: Partial<Record<CVSectionKey, string>> = {
  experience: "What you did and the result",
  projects: "What you built and the result",
};

/** A neutral silhouette for an empty photo slot; "cvmissingphoto" lets markMissingDetails find its <img>. */
const PLACEHOLDER_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg id='cvmissingphoto' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 150'><rect width='120' height='150' fill='#fff2eb'/><circle cx='60' cy='58' r='26' fill='#ffc7a8'/><path d='M12 150c4-34 24-52 48-52s44 18 48 52z' fill='#ffc7a8'/></svg>"
)}`;

/** `content` with placeholders for what the template shows but the CV lacks. */
export function withMissingDetails(content: Content, sections: CVSectionKey[]): Content {
  const result: Content = { ...content };

  const personal: Content = { ...((content.personal as Content | undefined) ?? {}) };
  if (!has(personal.full_name)) personal.full_name = missing("personal", "Your Name");
  if (!has(personal.title)) personal.title = missing("personal", "Professional title");
  if (!has(personal.email)) personal.email = missing("personal", "Email");
  if (!has(personal.phone)) personal.phone = missing("personal", "Phone");
  if (!has(personal.location)) personal.location = missing("personal", "Location");
  if (!asItems(personal.links).some((link) => has(link.url))) {
    personal.links = [{ label: missing("personal", "Link"), url: missing("personal", "Add a link") }];
  }
  if (sections.includes("photo") && !has(personal.photo)) personal.photo = PLACEHOLDER_PHOTO;
  result.personal = personal;

  for (const key of sections) {
    if (sectionIsEmpty(key, content)) {
      Object.assign(result, emptySection(key) ?? {});
      continue;
    }
    const fields = ENTRY_FIELDS[key];
    if (!fields) continue;
    result[key] = asItems(content[key]).map((entry) => {
      const filled: Content = { ...entry };
      for (const [field, text] of fields) {
        if (!has(filled[field])) filled[field] = missing(key, text);
      }
      if (DATED.includes(key) && !has(filled.start_date) && !has(filled.end_date)) {
        filled.start_date = missing(key, "Start");
        filled.end_date = missing(key, "End");
      }
      if (key === "education" && !has(filled.start_date) && !has(filled.end_date)) {
        filled.end_date = missing(key, "Graduation");
      }
      const bullets = Array.isArray(filled.bullets) ? filled.bullets : [];
      if (BULLETED.includes(key) && bullets.length === 0 && !has(filled.description)) {
        filled.bullets = [{ text: missing(key, BULLET_PLACEHOLDER[key] ?? "Add a bullet point") }];
      }
      return filled;
    });
  }
  return result;
}

const MARKED = new RegExp(`${OPEN}([A-Za-z]+)${SEP}([^${CLOSE}]*)${CLOSE}`, "g");
const STRAY_MARKER = /[-]/g;

/**
 * Turns the preview's markers into spans: content paths (see content-paths.ts)
 * into <span data-cv>, placeholders into highlighted <span class="cv-missing">.
 * Inside tags and <title> only the text is kept.
 */
export function markMissingDetails(html: string): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, (title) => title.replace(PATH_MARKED, "$2").replace(MARKED, "$2").replace(STRAY_MARKER, ""))
    .replace(/(<[^>]*>)|([^<]+)/g, (_match, tag: string | undefined, text: string | undefined) => {
      if (tag === undefined) {
        return (text ?? "")
          .replace(PATH_MARKED, '<span data-cv="$1">$2</span>')
          .replace(MARKED, '<span class="cv-missing" data-missing="$1">$2</span>');
      }
      const clean = tag.replace(PATH_MARKED, "$2").replace(MARKED, "$2").replace(STRAY_MARKER, "");
      // The placeholder photo is clickable like any other missing detail.
      return clean.startsWith("<img") && clean.includes("cvmissingphoto")
        ? clean.replace("<img", '<img data-missing="personal" style="outline:1.5px dashed rgba(255,94,31,.85);outline-offset:2px;cursor:pointer"')
        : clean;
    });
}

/** How placeholders look in the preview: the CV's own type, tinted and underlined in the app's accent. */
export const MISSING_DETAILS_CSS = `
.cv-missing {
  color: inherit;
  opacity: 0.6;
  font-style: italic;
  background: rgba(255, 94, 31, 0.12);
  text-decoration: underline dashed rgba(255, 94, 31, 0.85);
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
  border-radius: 2px;
  cursor: pointer;
}
`;
