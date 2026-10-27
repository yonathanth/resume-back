/**
 * The catalog of every CV section this app knows about. Templates pick from
 * this list (config/cv-templates.ts) — a template can never define a section
 * of its own, which is what keeps every CV switchable between every template
 * without losing content.
 *
 * Adding a section = one entry here, plus: its zod shape in
 * schemas/cv-content.schema.ts, an inline partial in each template that shows
 * it, and its editor form on the frontend. The AI prompt, the generated-output
 * filter, and the "ask if missing" questions all read from this catalog.
 */

export type CVSectionKey =
  | "summary"
  | "experience"
  | "education"
  | "projects"
  | "skills"
  | "certifications"
  | "languages"
  | "awards"
  | "publications"
  | "volunteering"
  | "courses"
  | "memberships"
  | "presentations"
  | "interests"
  | "references"
  | "personalDetails"
  | "research"
  | "teaching"
  | "activities"
  | "consent"
  | "photo";

export interface CVSectionDefinition {
  key: CVSectionKey;
  label: string;
  /**
   * Core sections are always requested from the AI, whatever the template —
   * every CV needs them (and finalize requires experience + skills).
   * Every other section is only requested when the chosen template shows it.
   */
  core: boolean;
  /** Top-level CVContent keys this section owns (photo lives inside `personal`). */
  contentKeys: string[];
  /**
   * The section's line(s) in the AI's OUTPUT SCHEMA. Absent for core sections
   * (they're part of the base schema) and for sections the AI never writes.
   */
  schema?: string;
  /** The AI must never produce this section (e.g. the photo is uploaded, not generated). */
  userProvidedOnly?: boolean;
  /**
   * Asked when a template marks the section `askIfMissing` and the user's
   * material has nothing for it. The answer is folded back into the next AI
   * pass, which places it in this section.
   */
  missingQuestion?: { question: string; reason: string; type: "text" | "textarea" };
}

export const CV_SECTION_CATALOG: Record<CVSectionKey, CVSectionDefinition> = {
  summary: {
    key: "summary",
    label: "Summary",
    core: false,
    contentKeys: ["summary"],
    schema: `  summary?: string;  // 2-4 sentences, no "I"; omit if there's too little material for an honest one`,
    missingQuestion: {
      question: "How would you describe yourself professionally in a sentence or two?",
      reason: "This template opens with a short professional summary.",
      type: "textarea",
    },
  },
  experience: { key: "experience", label: "Experience", core: true, contentKeys: ["experience"] },
  education: { key: "education", label: "Education", core: true, contentKeys: ["education"] },
  skills: { key: "skills", label: "Skills", core: true, contentKeys: ["skills", "skillGroups"] },
  projects: {
    key: "projects",
    label: "Projects",
    core: false,
    contentKeys: ["projects"],
    schema: `  projects: { name: string; subtitle?: string; tech?: string[]; url?: string; bullets: Bullet[] }[];  // subtitle: a short phrase saying what the project is (e.g. "Offline-first gym management platform") whenever the source says what it is`,
    missingQuestion: {
      question: "Any projects you'd like to include (personal, academic, or open source)?",
      reason: "This template has a Projects section. Describe each project, its tech stack, and what it achieved.",
      type: "textarea",
    },
  },
  certifications: {
    key: "certifications",
    label: "Certifications",
    core: false,
    contentKeys: ["certifications"],
    schema: `  certifications: { name: string; issuer?: string; date?: string; expires?: string; url?: string }[];  // omit issuer/expires if the source doesn't state them`,
    missingQuestion: {
      question: "Do you hold any certifications?",
      reason: "This template has a Certifications section. Include the issuer and date if you know them.",
      type: "textarea",
    },
  },
  languages: {
    key: "languages",
    label: "Languages",
    core: false,
    contentKeys: ["languages"],
    schema: `  languages: { language: string; proficiency: string }[];  // proficiency as stated, e.g. "Native", "Fluent", "B2"`,
    missingQuestion: {
      question: "Which languages do you speak, and how well?",
      reason: "This template lists spoken languages.",
      type: "text",
    },
  },
  awards: {
    key: "awards",
    label: "Awards",
    core: false,
    contentKeys: ["awards"],
    schema: `  awards: { title: string; issuer?: string; date?: string; description?: string }[];  // honors, prizes, scholarships, competition placements`,
    missingQuestion: {
      question: "Have you received any awards, honors, scholarships, or competition placements?",
      reason: "This template has an Awards section.",
      type: "textarea",
    },
  },
  publications: {
    key: "publications",
    label: "Publications",
    core: false,
    contentKeys: ["publications"],
    schema: `  publications: { title: string; authors?: string; venue?: string; date?: string; url?: string }[];  // papers, articles, books; venue = journal/conference/publisher`,
    missingQuestion: {
      question: "Do you have any publications (papers, articles, books)?",
      reason: "This template has a Publications section. Include the venue and year.",
      type: "textarea",
    },
  },
  volunteering: {
    key: "volunteering",
    label: "Volunteering",
    core: false,
    contentKeys: ["volunteering"],
    schema: `  volunteering: { organization: string; role?: string; location?: string; start_date?: string; end_date?: string | "present"; bullets: Bullet[] }[];`,
    missingQuestion: {
      question: "Any volunteer work you'd like to include?",
      reason: "This template has a Volunteering section.",
      type: "textarea",
    },
  },
  courses: {
    key: "courses",
    label: "Courses",
    core: false,
    contentKeys: ["courses"],
    schema: `  courses: { name: string; institution?: string; date?: string }[];  // relevant coursework, bootcamps, online courses`,
    missingQuestion: {
      question: "Any relevant courses, coursework, or training?",
      reason: "This template lists relevant courses.",
      type: "textarea",
    },
  },
  memberships: {
    key: "memberships",
    label: "Memberships",
    core: false,
    contentKeys: ["memberships"],
    schema: `  memberships: { organization: string; role?: string; start_date?: string; end_date?: string | "present" }[];  // professional bodies, clubs, associations`,
    missingQuestion: {
      question: "Are you a member of any professional organizations or associations?",
      reason: "This template has a Memberships section.",
      type: "textarea",
    },
  },
  presentations: {
    key: "presentations",
    label: "Talks & Presentations",
    core: false,
    contentKeys: ["presentations"],
    schema: `  presentations: { title: string; event?: string; date?: string; url?: string }[];  // talks, conference presentations, workshops given`,
    missingQuestion: {
      question: "Have you given any talks, presentations, or workshops?",
      reason: "This template has a Talks & Presentations section.",
      type: "textarea",
    },
  },
  interests: {
    key: "interests",
    label: "Interests",
    core: false,
    contentKeys: ["interests"],
    schema: `  interests: string[];  // short items, e.g. "Chess", "Open-source contributing"`,
    missingQuestion: {
      question: "Any interests or hobbies you'd like to mention?",
      reason: "This template has a short Interests section.",
      type: "text",
    },
  },
  references: {
    key: "references",
    label: "References",
    core: false,
    contentKeys: ["references"],
    schema: `  references: { name: string; title?: string; organization?: string; relationship?: string; email?: string; phone?: string }[];  // only people the source names as references — never invent contact details`,
    missingQuestion: {
      question: "Would you like to list references? If so, give their name, title, organization, and contact details.",
      reason: "This template has a References section. Leave empty to skip it.",
      type: "textarea",
    },
  },
  personalDetails: {
    key: "personalDetails",
    label: "Personal Details",
    core: false,
    contentKeys: ["personalDetails"],
    schema: `  personalDetails: { label: string; value: string }[];  // e.g. { label: "Nationality", value: "German" } — ONLY details the source explicitly states (date/place of birth, nationality, marital status, driving licence, address); never infer or guess any of them`,
  },
  research: {
    key: "research",
    label: "Research Experience",
    core: false,
    contentKeys: ["research"],
    schema: `  research: { title: string; organization?: string; location?: string; start_date?: string; end_date?: string | "present"; bullets: Bullet[] }[];  // research positions and projects (labs, theses, research assistantships) — keep regular jobs in experience`,
    missingQuestion: {
      question: "Do you have any research experience (lab work, a thesis, a research assistantship)?",
      reason: "This template has a Research Experience section.",
      type: "textarea",
    },
  },
  teaching: {
    key: "teaching",
    label: "Teaching Experience",
    core: false,
    contentKeys: ["teaching"],
    schema: `  teaching: { title: string; organization?: string; location?: string; start_date?: string; end_date?: string | "present"; bullets: Bullet[] }[];  // courses taught, tutoring, TA roles — title is the course or role`,
    missingQuestion: {
      question: "Have you taught, tutored, or been a teaching assistant?",
      reason: "This template has a Teaching Experience section.",
      type: "textarea",
    },
  },
  activities: {
    key: "activities",
    label: "Activities",
    core: false,
    contentKeys: ["activities"],
    schema: `  activities: { title: string; organization?: string; location?: string; start_date?: string; end_date?: string | "present"; bullets: Bullet[] }[];  // extracurricular activities, clubs, student organizations — unpaid, not volunteering`,
    missingQuestion: {
      question: "Any extracurricular activities, clubs, or student organizations?",
      reason: "This template has an Activities section.",
      type: "textarea",
    },
  },
  consent: {
    key: "consent",
    label: "Data Consent",
    core: false,
    contentKeys: ["consent"],
    // A legal clause (e.g. GDPR consent common on EU CVs) — the user writes it.
    userProvidedOnly: true,
  },
  photo: {
    key: "photo",
    label: "Photo",
    core: false,
    contentKeys: [],
    userProvidedOnly: true,
  },
};

export const ALL_SECTION_KEYS = Object.keys(CV_SECTION_CATALOG) as CVSectionKey[];

export function isCVSectionKey(value: string): value is CVSectionKey {
  return value in CV_SECTION_CATALOG;
}
