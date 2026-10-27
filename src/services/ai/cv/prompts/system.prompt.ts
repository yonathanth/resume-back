import { CV_SECTION_CATALOG, type CVSectionKey } from "../../../../config/cv-sections";
import { CV_RULES } from "../rules";

function buildOutputSchema(optionalSections: CVSectionKey[]): string {
  // Each optional section's schema line lives with it in the section catalog.
  const optionalLines = optionalSections
    .map((key) => CV_SECTION_CATALOG[key].schema)
    .filter((line): line is string => Boolean(line));
  return [
    `interface Bullet {`,
    `  label?: string;   // 2-4 word theme shown in bold before the text, e.g. "Frontend Architecture" — see STRICT SHAPE RULES`,
    `  text: string;     // the achievement itself; never repeats the label`,
    `}`,
    `interface CVContent {`,
    `  personal: {`,
    `    full_name?: string;      // omit if the source doesn't state it — ask via questions instead`,
    `    title?: string;          // omit if not stated or clearly implied — ask via questions instead`,
    `    email?: string;          // omit if the source doesn't contain one — ask via questions instead`,
    `    phone?: string;`,
    `    location?: string;`,
    `    links?: { label: string; url: string }[];`,
    `  };`,
    `  experience: {`,
    `    company?: string;        // omit if the source doesn't explicitly name an employer`,
    `    role?: string;           // omit if the source doesn't explicitly state a title`,
    `    location?: string;`,
    `    url?: string;            // company website, only if given in the source`,
    `    start_date?: string;     // "2023-01" — omit if not explicitly stated`,
    `    end_date?: string | "present";  // omit if not explicitly stated`,
    `    bullets: Bullet[];`,
    `  }[];`,
    `  education: {`,
    `    institution?: string;    // omit if the source doesn't name it`,
    `    degree?: string;`,
    `    field?: string;`,
    `    location?: string;`,
    `    gpa?: string;            // e.g. "3.63/4.0", only if stated`,
    `    start_date?: string;`,
    `    end_date?: string;       // may be free text such as "Expected 2026"`,
    `    honors?: string;         // only if stated; never inferred from GPA`,
    `    bullets?: Bullet[];      // thesis title, final grade, notable coursework — only if stated`,
    `  }[];`,
    `  skills: string[];`,
    `  skillGroups?: { category: string; items: string[] }[];  // REQUIRED when skills has 6+ items; e.g. { category: "Frontend", items: ["React", "Next.js"] }`,
    ...optionalLines,
    `}`,
  ].join("\n");
}

export interface SystemPromptInput {
  optionalSections: CVSectionKey[];
  enhancementLevel: number;
}

/**
 * Composes the full system prompt from the centralized CV_RULES modules plus
 * the output schema for this template's supported sections. This is the only
 * place these rule modules are combined — providers must not build their own
 * prompt text (see openai-compatible.provider.ts, which only sends what this returns).
 */
export function buildSystemPrompt({ optionalSections, enhancementLevel }: SystemPromptInput): string {
  const topLevelKeys = [
    "personal",
    "experience",
    "education",
    "skills",
    "skillGroups",
    ...optionalSections.flatMap((key) => CV_SECTION_CATALOG[key].contentKeys),
  ];

  return [
    CV_RULES.core(),
    CV_RULES.content(),
    CV_RULES.hallucination(),
    CV_RULES.tailoring(),
    CV_RULES.enhancement(enhancementLevel),
    CV_RULES.formatting(topLevelKeys),
    CV_RULES.clarification(),
    `OUTPUT SCHEMA\nRespond with a single JSON object matching EXACTLY ONE of these two shapes — never both, never a mix:\n\n1. The normal case:\ninterface AnalyzeResult {\n  candidateData: CVContent;\n  questions: ClarificationQuestion[];  // [] when nothing needs asking — see CLARIFICATION QUESTIONS\n  jobAnalysis: null | { mismatch: false; gaps?: string[] };  // null when no job description was given\n}\n${buildOutputSchema(optionalSections)}\ninterface ClarificationQuestion {\n  id: string;\n  question: string;\n  reason: string;\n  type: "text" | "textarea" | "select" | "date";\n  required: boolean;\n  options?: string[];\n}\n\n2. The role-mismatch case (only when the ROLE COMPATIBILITY CHECK in the tailoring rules applies):\ninterface RoleMismatch {\n  mismatch: true;\n  reason: string;\n  missing: string[];\n}`,
  ].join("\n\n");
}
