/**
 * enhancementLevel controls WRITING INTENSITY — how far the AI builds on the
 * candidate's material: how much it rewrites, expands and elaborates. The
 * HARD FACTS line in hallucination.rules.ts (names, dates, credentials,
 * contact details) is identical at every level, including 1.0.
 *
 * Bands are wide, mutually exclusive ranges rather than nearest-anchor
 * interpolation (the previous design): every level maps unambiguously to
 * exactly one band, two levels in different bands always receive visibly
 * different guidance, and each band carries calibration examples so the
 * model has a concrete anchor for how much rewriting is expected — abstract
 * adjectives alone ("stronger", "more polished") were not enough to produce
 * a visible difference between adjacent levels in practice. Each band also
 * pins down two mechanical levers that turned out to matter more than prose
 * adjectives for producing a visible difference run-to-run: how many source
 * bullets may be merged into one, and how assertive the summary may read.
 *
 * How far to tailor to a job description is fixed, not per band — see
 * tailoring.rules.ts's "HOW FAR TO TAILOR" section.
 */

interface EnhancementExample {
  source: string;
  output: string;
}

interface EnhancementBand {
  label: string;
  guidance: string[];
  bulletMerging: string;
  summaryStyle: string;
  examples: EnhancementExample[];
  /** One punchy sentence repeated at the end of the user message — see getEnhancementReminder. */
  reminder: string;
}

const FORBIDDEN_FILLER_PHRASES = [
  "ensuring reliability",
  "ensuring reliable performance",
  "ongoing enhancements",
  "delivering timely results",
  "maintaining high quality",
  "consistent user experience(s)",
  "seamless",
  "robust",
  "cutting-edge",
  "high-quality",
];

const CONSERVATIVE: EnhancementBand = {
  label: "Conservative",
  guidance: [
    "Preserve the candidate's original meaning, wording, and sentence boundaries as closely as possible.",
    "Fix grammar, verb tense, and word order only — this is a light copy-edit, not a rewrite.",
    `Do not add outcome, scale, quality, or context words the source never stated. This includes generic filler that sounds harmless but states an unverified outcome — e.g. ${FORBIDDEN_FILLER_PHRASES.map((p) => `"${p}"`).join(", ")}. If a bullet doesn't already end after describing the action and its stated object, you have added something the source didn't say — cut it.`,
    "Do not name specific roles, tools, or collaborators the source only referred to generically (e.g. leave 'cross-functional teams' as-is — do not guess which functions were involved).",
  ],
  bulletMerging: "Never merge two source sentences into one bullet. One source sentence/point stays one bullet.",
  summaryStyle:
    "One short, plain sentence restating the candidate's stated experience in professional phrasing. No claims of impact, scope, or seniority beyond what is stated.",
  examples: [
    {
      source: "Built React interfaces.",
      output: "Built interfaces using React.",
    },
    {
      source: "Collaborated with cross-functional teams to implement features.",
      output: "Collaborated with cross-functional teams to implement features.",
    },
  ],
  reminder:
    "This is enhancement level 0.0–0.2 (Conservative): make only a light grammar/wording copy-edit of each source point, one bullet per source point, no added outcome/scope/quality words and no named specifics for anything the source only described generically.",
};

const MODERATE: EnhancementBand = {
  label: "Moderate",
  guidance: [
    "Rewrite weak or informal descriptions into professional CV language.",
    "Convert responsibilities into stronger, achievement-oriented bullets where the outcome is reasonably supported by the source.",
    "Allow limited, wording-level inference from what is explicitly stated (e.g. building interfaces implies frontend development work; a generically named group like 'cross-functional teams' may be given plausible, everyday specifics like 'designers and product managers' — common roles that ordinarily make up such a team — without claiming a new fact).",
    "Highlight relevant skills, including ones clearly demonstrated by the described work.",
  ],
  bulletMerging: "Still one source sentence/point per bullet, but the sentence may be restructured and enriched with plausible wording-level detail.",
  summaryStyle:
    "One to two sentences in confident professional language, still closely tracking the source's actual content and scope.",
  examples: [
    {
      source: "Built React interfaces.",
      output: "Developed React interfaces, focusing on clean, reusable component structure.",
    },
    {
      source: "Collaborated with cross-functional teams to implement features.",
      output: "Collaborated with cross-functional teams, including designers and product managers, to define and implement features.",
    },
  ],
  reminder:
    "This is enhancement level 0.2–0.5 (Moderate): rewrite into stronger professional CV language and reword matched bullets toward the job's terminology, staying one source point per bullet.",
};

const STRONG: EnhancementBand = {
  label: "Strong",
  guidance: [
    "Significantly improve the candidate's professional positioning with more substantial rewriting than the Moderate band.",
    "Use stronger, more specific CV language and emphasize transferable skills.",
    "Reasonably infer common responsibilities that ordinarily accompany the stated work (e.g. someone who built interfaces likely coordinated with other engineers), as long as the inference is a plausible, everyday extension of the stated experience — not a new fact.",
    "Make bullets substantially richer than the source material: add the concrete tasks, tools and outcomes that ordinarily come with the work described.",
  ],
  bulletMerging:
    "You may merge two closely related source sentences into a single, fuller bullet when doing so produces a more coherent professional statement — but every fact in the merged bullet must still trace back to the source.",
  summaryStyle:
    "Two to three sentences of confident, specific professional positioning. When a job description is provided, lead with the candidate's strongest genuinely-matching strengths, using the job's own terminology for them.",
  examples: [
    {
      source: "Built React interfaces.",
      output:
        "Developed responsive React interfaces using reusable components, collaborating with backend engineers to integrate application functionality.",
    },
    {
      source: "Collaborated with cross-functional teams to implement features.",
      output:
        "Partnered closely with cross-functional teams, including designers and product managers, to define requirements and implement features from concept through delivery.",
    },
  ],
  reminder:
    "This is enhancement level 0.5–0.8 (Strong): significantly rewrite and restructure toward the job, merging related bullets and using matched job terminology throughout — building each bullet out with the concrete detail the described work implies.",
};

const MAXIMUM: EnhancementBand = {
  label: "Maximum",
  guidance: [
    "Produce the strongest, most detailed professional presentation the source can support — this must read as more assertive and more elaborated than the Strong band, never merely different.",
    "Aggressively rewrite vague or weak descriptions into detailed, impactful, achievement-oriented language.",
    "Combine and elaborate on related pieces of source information into fuller, more complete bullets and a more assertive professional summary.",
    "Allow reasonable inferred responsibilities and transferable-skill framing wherever they are a plausible, everyday extension of stated experience.",
    "This band's output must never be shorter, vaguer, or less specific than what the Strong band would produce for the same source.",
  ],
  bulletMerging:
    "Combine related source sentences into fuller, more complete bullets wherever it strengthens the narrative — a role's bullet count may shrink while each bullet's depth grows, as long as no bullet states a fact absent from the source.",
  summaryStyle:
    "Two to four sentences of the most assertive, specific professional positioning the source can honestly support. With a job description, aggressively lead with and elaborate on every genuine STRONG match, and frame TRANSFERABLE matches with confident, direct language.",
  examples: [
    {
      source: "Built React interfaces.",
      output:
        "Engineered responsive, component-based React interfaces, partnering with backend engineers to deliver end-to-end application functionality and a consistent user experience.",
    },
    {
      source: "Collaborated with cross-functional teams to implement features.",
      output:
        "Drove cross-functional collaboration with designers and product managers, from requirements definition through implementation, to consistently deliver well-scoped, user-facing features.",
    },
  ],
  reminder:
    "This is enhancement level 0.8–1.0 (Maximum): produce the most assertive, elaborated, job-aligned presentation the source can honestly support — visibly stronger and more detailed than the Strong band would produce for the same source, while never inventing a HARD FACT.",
};

function pickBand(level: number): EnhancementBand {
  if (level <= 0.2) return CONSERVATIVE;
  if (level <= 0.5) return MODERATE;
  if (level <= 0.8) return STRONG;
  return MAXIMUM;
}

function formatExamples(examples: EnhancementExample[]): string {
  return examples
    .map((ex, i) => `  Example ${i + 1}:\n    Source: "${ex.source}"\n    Expected style of output at this level: "${ex.output}"`)
    .join("\n");
}

/**
 * A single reinforcement sentence for the active band, meant to be placed at
 * the very end of the user message (see user.prompt.ts) rather than only in
 * the system prompt. Model instruction-following in practice weights content
 * near the end of the prompt, right before generation, more heavily than the
 * same instruction stated once earlier alongside five other rule modules —
 * this is what closed the gap between the 0.0 and 0.9 bands actually being
 * followed instead of just being present in the prompt.
 */
export function getEnhancementReminder(level: number): string {
  return pickBand(level).reminder;
}

export function getEnhancementRules(level: number): string {
  const band = pickBand(level);

  return `ENHANCEMENT LEVEL: ${level.toFixed(2)} (${band.label})
This value controls WRITING INTENSITY: how far you build on the candidate's material — how much you rewrite, expand and elaborate. The HARD FACTS line (see FACTUAL BOUNDARY below) is the same at every level.

${band.guidance.map((line) => `- ${line}`).join("\n")}

BULLET MERGING AT THIS LEVEL: ${band.bulletMerging}

SUMMARY STYLE AT THIS LEVEL: ${band.summaryStyle}

CALIBRATION EXAMPLES at this level (same source sentences, showing the expected magnitude of rewriting):
${formatExamples(band.examples)}
A higher enhancement level must always read as more detailed and more assertively positioned than a lower one applied to the same source material — never shorter, vaguer, or less specific than a lower level's output. Two different levels applied to the same source must never produce near-identical output — the calibration examples above show the actual, visible degree of change expected; matching that degree of change matters as much as respecting the FACTUAL BOUNDARY below.

FACTUAL BOUNDARY — identical at every enhancement level, including 1.0:
Never invent a HARD FACT (employer, school, degree, certification, date, contact detail, link, award, publication, spoken language). Everything else — responsibilities, implied tools, scope, favourable framing — is yours to build out, more so at higher levels.`;
}
