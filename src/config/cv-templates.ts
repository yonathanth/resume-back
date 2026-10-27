/**
 * The CV templates that exist. Each is a folder under src/templates/<id>/
 * (`template.hbs` + `style.css`); this registry holds everything else about
 * it. Sections come from the shared catalog (config/cv-sections.ts) — a
 * template only chooses which catalog sections it shows, where, and in what
 * order. Section markup is shared (src/templates/_shared/); a template's own
 * files are mostly its header, column layout, and CSS.
 *
 * The same entry drives:
 * - rendering: which sections appear (main column / sidebar), their titles, fonts
 * - the AI: only these sections are requested, `aiNotes` are passed along
 *   as template-specific instructions, and every `askIfMissing` section
 *   with no content gets a clarification question
 * - the editor: which section forms are shown (GET /api/v1/templates)
 * - the gallery: name, description, category
 *
 * Adding a template = its folder + one entry here. No database change.
 */

import { CV_SECTION_CATALOG, isCVSectionKey, type CVSectionKey } from "./cv-sections";
import { CV_FONTS } from "./cv-fonts";

export type { CVSectionKey } from "./cv-sections";

/** Gallery groupings, in display order. */
export const TEMPLATE_CATEGORIES = ["Simple", "Professional", "Academic", "Two-column"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface CVTemplateDefinition {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Font families (keys of CV_FONTS) the template's CSS uses. */
  fonts: string[];
  /** Sections this template renders, in order. Omitted sections are never shown. */
  sections: CVSectionKey[];
  /** For two-column layouts: which of `sections` go in the sidebar (the rest go in the main column). */
  sidebar?: CVSectionKey[];
  /** Section headings that differ from the catalog labels ("Work experience", "Honors and Awards"...). */
  sectionTitles?: Partial<Record<CVSectionKey, string>>;
  /** Sections the user is asked about when their material has nothing for them. */
  askIfMissing?: CVSectionKey[];
  /**
   * Template-specific instructions for the AI (tone, length, what to
   * emphasize) — for exceptions only; general rules live in services/ai/cv/rules.
   */
  aiNotes?: string;
}

export const DEFAULT_CV_TEMPLATE_ID = "classic";

const DENSE_NOTES =
  "This is a dense, one-page layout. Keep any summary to at most two sentences, bullets to one or two lines, 2-4 bullets per role and 1-3 per project. Group skills into short categories such as Languages, Frontend, Backend, Tools.";

const SIDEBAR_NOTES =
  "This is a two-column layout with a narrow sidebar. Keep sidebar items short: skill groups of a few words each, languages with a one-word proficiency. Keep bullets concise (one line where possible).";

export const CV_TEMPLATE_REGISTRY: Record<string, CVTemplateDefinition> = {
  classic: {
    id: "classic",
    name: "Classic",
    description: "A clean, single-column layout in the style of classic LaTeX resumes. Fits a lot on one page.",
    category: "Simple",
    fonts: ["CMU Serif"],
    sections: [
      "summary",
      "education",
      "experience",
      "projects",
      "skills",
      "awards",
      "publications",
      "certifications",
      "volunteering",
      "languages",
    ],
    askIfMissing: ["projects"],
    aiNotes: DENSE_NOTES,
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    description: "Centered name, one line of contacts, small-caps sections. The popular one-page software resume.",
    category: "Simple",
    fonts: ["CMU Serif"],
    sections: ["education", "experience", "projects", "skills", "certifications", "awards", "languages"],
    sectionTitles: { skills: "Technical Skills" },
    askIfMissing: ["projects"],
    aiNotes: DENSE_NOTES,
  },
  focus: {
    id: "focus",
    name: "Focus",
    description: "Opens with your title and a summary, then skills before experience. Good for experienced professionals.",
    category: "Simple",
    fonts: ["CMU Serif"],
    sections: ["summary", "skills", "experience", "projects", "education", "certifications", "languages"],
    sectionTitles: { skills: "Technical Skills" },
    askIfMissing: ["summary"],
    aiNotes:
      "The summary leads this layout: write 3-4 sentences on experience, strengths, and the kind of role sought. Keep bullets outcome-focused. Group skills into categories such as Languages, Frameworks, Tools.",
  },
  stack: {
    id: "stack",
    name: "Stack",
    description: "A developer resume: your job title heads the summary, then skills, roles, and projects with their tech stack.",
    category: "Simple",
    fonts: ["Source Sans 3"],
    sections: [
      "summary",
      "skills",
      "experience",
      "education",
      "projects",
      "certifications",
      "awards",
      "publications",
      "volunteering",
      "languages",
    ],
    sectionTitles: { skills: "Technical Skills" },
    askIfMissing: ["projects"],
    aiNotes:
      "This is a one-page developer resume. The summary sits under the person's job title: 2-3 sentences. Group skills into short categories such as Languages, Frameworks, Libraries, Databases, Dev Tools (category names of one or two words). Use 2-4 bullets per role and per project, each one line where possible.",
  },
  prose: {
    id: "prose",
    name: "Prose",
    description: "Times type, a blue centered name, and paragraph-style sections where each item opens with a blue label.",
    category: "Professional",
    fonts: ["Tinos"],
    sections: [
      "summary",
      "skills",
      "experience",
      "projects",
      "education",
      "certifications",
      "awards",
      "publications",
      "languages",
      "volunteering",
      "interests",
    ],
    sectionTitles: { skills: "Technical Skills" },
    aiNotes:
      "Every item reads as a short paragraph led by a label (\"Data Analysis — ...\"). Open with a 2-3 sentence summary. Group skills into 3-6 categories. Keep bullets to one or two lines, 2-4 per role.",
  },
  banner: {
    id: "banner",
    name: "Banner",
    description: "Bold uppercase name, one line of contacts, and light gray band headings with dates in a clear column.",
    category: "Professional",
    fonts: ["Montserrat"],
    sections: [
      "summary",
      "skills",
      "experience",
      "education",
      "projects",
      "certifications",
      "awards",
      "volunteering",
      "languages",
      "interests",
      "references",
    ],
    sectionTitles: { experience: "Work Experience" },
    aiNotes:
      "Job lines read \"Role | Company\" with the dates beside them, so keep role titles short. Open with a 2-4 sentence summary. Use 2-4 bullets per role, one or two lines each.",
  },
  linen: {
    id: "linen",
    name: "Linen",
    description: "An elegant spaced serif name, contacts in a soft beige bar, and ruled headings over justified text.",
    category: "Professional",
    fonts: ["Cormorant Garamond", "Arimo"],
    sections: [
      "summary",
      "experience",
      "education",
      "skills",
      "projects",
      "certifications",
      "awards",
      "languages",
      "volunteering",
      "interests",
      "references",
    ],
    sectionTitles: { summary: "Professional Summary" },
    aiNotes:
      "Each job leads with the company, then the position. Open with a 3-4 sentence professional summary. Use 2-4 bullets per role; they may run to two lines.",
  },
  crest: {
    id: "crest",
    name: "Crest",
    description: "A navy header band with a gold name, then two columns: your experience on the left and a ruled list of key skills on the right.",
    category: "Professional",
    fonts: ["Poppins"],
    sections: [
      "summary",
      "experience",
      "projects",
      "education",
      "certifications",
      "awards",
      "volunteering",
      "references",
      "skills",
      "languages",
      "interests",
    ],
    // The right-hand column, from the top of the page down.
    sidebar: ["skills", "languages", "interests"],
    sectionTitles: { experience: "Work Experience", skills: "Key Skills" },
    aiNotes:
      "Job lines read \"Role, Company\" beside the dates in a column about two thirds of the page wide, so keep role titles short. Open with a 2-3 sentence summary. Key skills sit in a narrow column: list them as short phrases of two to four words, without categories.",
  },
  clarity: {
    id: "clarity",
    name: "Clarity",
    description: "A big uppercase name with the title alongside, plain bold headings, and education and skills in two columns.",
    category: "Professional",
    fonts: ["Montserrat"],
    sections: [
      "summary",
      "experience",
      "education",
      "skills",
      "projects",
      "certifications",
      "awards",
      "volunteering",
      "languages",
      "references",
    ],
    sectionTitles: { summary: "Professional Summary", experience: "Work Experience" },
    aiNotes:
      "Skills fill a two-column bullet list: write them as short phrases (\"Budgeting & Cost Control\"), without categories. Open with a 3-4 sentence summary. Use 2-4 bullets per role.",
  },
  formal: {
    id: "formal",
    name: "Formal",
    description: "Navy name, labeled personal details, and table-style sections. Suited to institutions and research centers.",
    category: "Professional",
    fonts: ["CMU Serif"],
    sections: [
      "personalDetails",
      "summary",
      "education",
      "experience",
      "activities",
      "skills",
      "languages",
      "projects",
      "publications",
      "certifications",
      "awards",
      "memberships",
    ],
    // Not a visual sidebar: the template places personal details in its header.
    sidebar: ["personalDetails"],
    sectionTitles: {
      experience: "Work Experience",
      activities: "Extracurricular Activities",
      languages: "Language Proficiencies",
      projects: "Portfolio of Relevant Projects",
    },
    aiNotes:
      "This is a formal, institutional layout. Keep the tone measured and factual. Education entries may list the thesis title and final grade as bullets when the source states them.",
  },
  scholar: {
    id: "scholar",
    name: "Scholar",
    description: "An academic CV with an optional round photo, classic serif type, and room for teaching, talks, and honors.",
    category: "Academic",
    fonts: ["Libertinus Serif"],
    sections: [
      "photo",
      "education",
      "experience",
      "research",
      "projects",
      "publications",
      "presentations",
      "awards",
      "teaching",
      "volunteering",
      "skills",
      "languages",
    ],
    sectionTitles: {
      experience: "Work Experience",
      projects: "Projects and Research",
      presentations: "Conferences and Presentations",
      awards: "Honors and Awards",
      volunteering: "Community Involvement",
    },
    aiNotes:
      "This is an academic CV and may run to two pages. Describe research and projects precisely (methods, tools, outcomes). Awards may carry a one-line description of what they recognize.",
  },
  research: {
    id: "research",
    name: "Research",
    description: "An undergraduate research CV: research experience first, presentations, honors, and interests.",
    category: "Academic",
    fonts: ["Libre Baskerville"],
    sections: [
      "education",
      "research",
      "experience",
      "presentations",
      "publications",
      "awards",
      "skills",
      "interests",
    ],
    sectionTitles: {
      research: "Research Experience",
      experience: "Other Experience",
      presentations: "Research Presentations",
      awards: "Awards & Honors",
      skills: "Specialized Skills",
      interests: "Other Interests",
    },
    askIfMissing: ["research"],
    aiNotes:
      "This CV is for research programs. Put lab work, theses, and research assistantships in research, and other jobs in experience. Keep bullets short (one line each).",
  },
  curve: {
    id: "curve",
    name: "Curve",
    description: "An academic CV with dates in a left column, olive swish headings, icon contacts, and an optional photo.",
    category: "Academic",
    fonts: ["Crimson Text", "Cabin", "Inconsolata"],
    sections: [
      "photo",
      "summary",
      "experience",
      "education",
      "research",
      "teaching",
      "publications",
      "presentations",
      "awards",
      "skills",
      "languages",
      "memberships",
      "volunteering",
      "interests",
      "references",
    ],
    sectionTitles: {
      summary: "Profile",
      experience: "Employment",
      presentations: "Talks",
      references: "Referees",
    },
    aiNotes:
      "This is an academic CV that may run to two pages. Each entry leads with \"Role, Organisation, Place\" beside its dates, then 1-3 concise bullets. Skill group names sit in a narrow left column: keep them to one or two words.",
  },
  accent: {
    id: "accent",
    name: "Accent",
    description: "A modern two-column layout with a purple accent, round photo, and a sidebar for skills and languages.",
    category: "Two-column",
    fonts: ["Lato"],
    sections: [
      "photo",
      "summary",
      "experience",
      "projects",
      "education",
      "publications",
      "skills",
      "languages",
      "certifications",
      "awards",
      "interests",
    ],
    sidebar: ["skills", "languages", "certifications", "awards", "interests"],
    sectionTitles: { summary: "About Me", skills: "Strengths" },
    aiNotes: SIDEBAR_NOTES,
  },
  sidebar: {
    id: "sidebar",
    name: "Sidebar",
    description: "A photo and personal details in a light sidebar, with a bold heading bar and dated experience on the right.",
    category: "Two-column",
    fonts: ["Raleway"],
    sections: [
      "photo",
      "personalDetails",
      "skills",
      "languages",
      "education",
      "interests",
      "summary",
      "experience",
      "projects",
      "publications",
      "certifications",
    ],
    sidebar: ["personalDetails", "skills", "languages", "education", "interests"],
    sectionTitles: { summary: "Biography", experience: "Work Experience" },
    aiNotes: SIDEBAR_NOTES,
  },
  bubble: {
    id: "bubble",
    name: "Bubble",
    description: "Round section icons, a timeline of roles, and a sidebar with contacts, skills, and language bars.",
    category: "Two-column",
    fonts: ["Source Sans 3"],
    sections: [
      "photo",
      "summary",
      "experience",
      "education",
      "projects",
      "awards",
      "skills",
      "languages",
      "certifications",
      "interests",
      "consent",
    ],
    sidebar: ["skills", "languages", "certifications", "interests"],
    sectionTitles: { summary: "Profile", experience: "Work Experience" },
    aiNotes: `${SIDEBAR_NOTES} List skills as short phrases.`,
  },
  slate: {
    id: "slate",
    name: "Slate",
    description: "A dark blue sidebar with your profile, contacts, and personal details beside a clean white column.",
    category: "Two-column",
    fonts: ["Fira Sans"],
    sections: [
      "photo",
      "summary",
      "personalDetails",
      "languages",
      "skills",
      "experience",
      "education",
      "courses",
      "projects",
      "certifications",
      "awards",
      "interests",
    ],
    sidebar: ["summary", "personalDetails", "languages", "skills"],
    sectionTitles: {
      summary: "Profile",
      personalDetails: "Personal Information",
      courses: "Additional Education",
      interests: "Hobbies",
    },
    aiNotes: `${SIDEBAR_NOTES} The profile sits in the sidebar: keep it to 3 short sentences.`,
  },
  capsule: {
    id: "capsule",
    name: "Capsule",
    description: "A rounded slate sidebar for contacts, skills, references, and languages, with pill headings and soft blue sections.",
    category: "Two-column",
    fonts: ["Poppins"],
    sections: [
      "summary",
      "experience",
      "education",
      "projects",
      "certifications",
      "awards",
      "volunteering",
      "skills",
      "languages",
      "interests",
      "references",
    ],
    sidebar: ["skills", "languages", "interests", "references"],
    sectionTitles: { summary: "About Me" },
    aiNotes: `${SIDEBAR_NOTES} List skills as short phrases of one to three words. Keep the About Me summary to 3-4 sentences.`,
  },
  campus: {
    id: "campus",
    name: "Campus",
    description: "A student CV: a gray header band, a sidebar with your profile and contacts, and arrow-marked sections.",
    category: "Two-column",
    fonts: ["Arimo", "Lora"],
    sections: [
      "summary",
      "experience",
      "education",
      "projects",
      "activities",
      "volunteering",
      "languages",
      "skills",
      "certifications",
      "courses",
      "awards",
      "interests",
    ],
    sidebar: ["summary", "interests"],
    sectionTitles: {
      summary: "Profile",
      experience: "Work Experience",
      activities: "Activities",
      volunteering: "Volunteer Experience",
    },
    aiNotes: `${SIDEBAR_NOTES} This layout suits students and first jobs: the profile sits in the sidebar, so keep it to 3-4 short sentences. Short part-time jobs, school activities and volunteering all count; keep each to a line or two.`,
  },
  midnight: {
    id: "midnight",
    name: "Midnight",
    description: "A dark page with a green accent: experience in rows, and an education timeline, skills, and contacts on the right.",
    category: "Two-column",
    fonts: ["Poppins"],
    sections: [
      "summary",
      "experience",
      "projects",
      "volunteering",
      "awards",
      "references",
      "education",
      "certifications",
      "skills",
      "languages",
      "interests",
    ],
    sidebar: ["education", "certifications", "skills", "languages", "interests"],
    sectionTitles: { experience: "Work Experience" },
    aiNotes: `${SIDEBAR_NOTES} The summary sits under the name as a short introduction: 2-3 sentences. Each role's details sit in a narrow column beside it: 2-3 short bullets.`,
  },
  timeline: {
    id: "timeline",
    name: "Timeline",
    description: "A navy sidebar with serif headings, and work experience laid out along a vertical timeline.",
    category: "Two-column",
    fonts: ["Poppins", "Lora"],
    sections: [
      "summary",
      "experience",
      "projects",
      "certifications",
      "awards",
      "volunteering",
      "references",
      "education",
      "skills",
      "languages",
      "interests",
    ],
    sidebar: ["education", "skills", "languages", "interests"],
    sectionTitles: { experience: "Work Experience" },
    aiNotes: `${SIDEBAR_NOTES} The summary sits under the name with no heading: 2-3 sentences. List skills as short phrases.`,
  },
  spark: {
    id: "spark",
    name: "Spark",
    description: "Our home page's \"after\" resume: a crisp orange accent, results-first bullets, and skill chips in a slim sidebar.",
    category: "Two-column",
    fonts: ["Geist"],
    sections: [
      "summary",
      "experience",
      "projects",
      "references",
      "skills",
      "education",
      "certifications",
      "awards",
      "volunteering",
      "languages",
      "interests",
    ],
    sidebar: ["skills", "education", "certifications", "awards", "volunteering", "languages", "interests"],
    aiNotes: `${SIDEBAR_NOTES} Lead every bullet with the result and a number where the source gives one. Group skills into 2-4 short categories (Languages, Frameworks, Tools) of a few items each. Keep sidebar entries to one line.`,
  },
  halo: {
    id: "halo",
    name: "Halo",
    description: "A header with a round photo and headline, and a sidebar for your summary, skills, languages, and hobbies.",
    category: "Two-column",
    fonts: ["Roboto"],
    sections: [
      "photo",
      "summary",
      "skills",
      "languages",
      "interests",
      "volunteering",
      "education",
      "experience",
      "projects",
      "awards",
      "publications",
      "certifications",
    ],
    sidebar: ["summary", "skills", "languages", "interests", "volunteering"],
    sectionTitles: {
      summary: "About Me",
      experience: "Professional Experience",
      awards: "Honors",
      interests: "Hobbies",
      volunteering: "Non-profit",
    },
    aiNotes: `${SIDEBAR_NOTES} Keep the About Me summary to 2 sentences.`,
  },
};

// Fail fast on a registry typo instead of silently rendering/asking nothing.
for (const template of Object.values(CV_TEMPLATE_REGISTRY)) {
  const referenced = [
    ...template.sections,
    ...(template.askIfMissing ?? []),
    ...(template.sidebar ?? []),
    ...(Object.keys(template.sectionTitles ?? {}) as CVSectionKey[]),
  ];
  for (const key of referenced) {
    if (!isCVSectionKey(key)) throw new Error(`Template "${template.id}" uses unknown section "${key}"`);
  }
  for (const key of [...(template.askIfMissing ?? []), ...(template.sidebar ?? [])]) {
    if (!template.sections.includes(key)) {
      throw new Error(`Template "${template.id}" references "${key}" but doesn't show it`);
    }
  }
  for (const font of template.fonts) {
    if (!(font in CV_FONTS)) throw new Error(`Template "${template.id}" uses unknown font "${font}"`);
  }
}

// Template ids stored before the registry held real templates (they were
// cosmetic gallery names). Kept resolvable so old drafts and clients still
// work; they all render as the default template.
const LEGACY_TEMPLATE_IDS = new Set(["default", "professional", "tech", "executive", "swiss", "finance", "ai", "creative"]);

/** Canonical template id for `templateId`, or null if it isn't a known (or legacy) id. */
/**
 * Gallery order: the default first, then the newest templates, then the
 * rest. Every registry id must appear here (checked in the unit tests).
 */
export const TEMPLATE_DISPLAY_ORDER: string[] = [
  "classic",
  // newest first
  "spark",
  "clarity",
  "timeline",
  "midnight",
  "crest",
  "linen",
  "campus",
  "capsule",
  "banner",
  // the originals
  "minimal",
  "focus",
  "stack",
  "prose",
  "formal",
  "scholar",
  "research",
  "curve",
  "accent",
  "sidebar",
  "bubble",
  "slate",
  "halo",
];

/** Every template, in gallery order (any id missing from the order list goes last). */
export function templatesInDisplayOrder(): CVTemplateDefinition[] {
  const rank = (id: string) => {
    const index = TEMPLATE_DISPLAY_ORDER.indexOf(id);
    return index === -1 ? TEMPLATE_DISPLAY_ORDER.length : index;
  };
  return Object.values(CV_TEMPLATE_REGISTRY).sort((a, b) => rank(a.id) - rank(b.id));
}

export function resolveCVTemplateId(templateId: string | null | undefined): string | null {
  if (!templateId) return null;
  if (templateId in CV_TEMPLATE_REGISTRY) return templateId;
  if (LEGACY_TEMPLATE_IDS.has(templateId)) return DEFAULT_CV_TEMPLATE_ID;
  return null;
}

export function isValidCVTemplateId(templateId: string): boolean {
  return resolveCVTemplateId(templateId) !== null;
}

export function getCVTemplate(templateId: string | null | undefined): CVTemplateDefinition {
  return CV_TEMPLATE_REGISTRY[resolveCVTemplateId(templateId) ?? DEFAULT_CV_TEMPLATE_ID];
}

export function sectionTitle(template: CVTemplateDefinition, key: CVSectionKey): string {
  return template.sectionTitles?.[key] ?? CV_SECTION_CATALOG[key].label;
}

/** Non-core sections the AI should write for this template (core ones are always written). */
export function getAIOptionalSections(templateId: string | null | undefined): CVSectionKey[] {
  return getCVTemplate(templateId).sections.filter((key) => {
    const section = CV_SECTION_CATALOG[key];
    return !section.core && !section.userProvidedOnly;
  });
}
