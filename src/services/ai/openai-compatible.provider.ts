import OpenAI from "openai";
import type {
  AIGenerateInput,
  AIProvider,
  JobRequirements,
  PolishCvInput,
  PolishCvResult,
  PolishSummaryInput,
  ReviewCvInput,
  ReviewTip,
  RoleMatch,
  RoleMatchInput,
  ScoreIssue,
} from "./provider.interface";
import type { AnalyzeResult, RoleMismatch } from "../../schemas/cv-content.schema";
import { buildCvGenerationPrompt } from "./cv/prompts/buildCvPrompt";
import { trackAiCall, type AiOperation } from "./usage";

const POLISH_SUMMARY_SYSTEM_PROMPT = `You polish a candidate's CV/resume professional summary. Rewrite the DRAFT SUMMARY the user gives you so it is clear, professional, concise, impactful, and ATS-friendly. Improve grammar, wording, structure, and consistency, and make sure it highlights the candidate's relevant skills, experience, and achievements. It must still read as humanized, natural writing — never stiff, robotic, or keyword-stuffed.

FACTUAL BOUNDARY (do not cross this):
- You may reword, restructure, tighten, and professionally reframe anything already stated or clearly implied in the draft summary or the supporting context (title, skills, experience bullets).
- You may modestly sharpen the delivery of a point already present (e.g. stronger verb, more confident framing of an existing achievement) — but you must NOT invent a new achievement, employer, metric, number, scope, team size, or responsibility that isn't already there.
- If the draft is short or generic, produce a tighter/cleaner version of what's there rather than padding it with invented specifics.

Keep it to 2-4 sentences, first-person implied (no "I"), no bullet points, no markdown, no em dashes (—), no quotation marks around the text.

Respond with a single compact JSON object with EXACTLY this key:
- "summary": string — the polished summary, ready to drop directly into the CV.`;

const JOB_ANALYSIS_SYSTEM_PROMPT = `You read a job description and list what it asks for. Be literal: only list what the text actually says.

- "title": the job title, without the company name.
- "seniority": one of "intern", "junior", "mid", "senior", "lead", "executive", or "" if unclear.
- "requiredSkills": up to 15 must-have skills, tools, technologies, certifications or domain areas (stated as required, "must have", or in the core responsibilities).
- "preferredSkills": up to 10 nice-to-haves ("preferred", "bonus", "a plus").
- "keywords": up to 15 other important terms (methodologies, industries, responsibilities) not already listed.

Each skill is a short, atomic noun phrase as a CV would write it ("Python", "Stakeholder management", "AWS"), never a sentence and never "X or Y" — split those into separate items. No soft-skill filler like "team player" or "good communication" unless the posting stresses it. No duplicates.

If the text is not a job description, return empty lists and an empty title.

Respond with a single compact JSON object with EXACTLY these keys: "title", "seniority", "requiredSkills", "preferredSkills", "keywords".`;

const CV_REVIEW_SYSTEM_PROMPT = `You are an experienced recruiter reviewing a CV. An automated check has already scored it and listed its ISSUES. Give the candidate up to 6 short, specific, actionable tips that go beyond those issues: weak or vague bullets (quote a few words of the bullet), achievements that need a number, missing context, ordering, and — when a TARGET JOB is given — how well the CV speaks to that job.

Rules:
- Be concrete and refer to the CV's actual content. No generic advice.
- Never suggest adding skills, employers, numbers or experience the candidate hasn't shown; say "if you have it" when pointing at a gap.
- Each tip is one or two sentences, plain text, no markdown.
- "section" is one of "personal", "summary", "experience", "education", "skills", "general".

Respond with a single compact JSON object with EXACTLY this key:
- "tips": array of {"section": string, "text": string}`;

const CV_POLISH_SYSTEM_PROMPT = `You polish parts of a CV so they pass an automated quality check, while keeping every fact true. You receive the full CV as FACTS, the check's ISSUES, an optional TARGET JOB, and the PARTS TO REWRITE. Return rewritten versions of only those parts.

Writing rules:
- Summary: 2–4 sentences, 40–80 words, no "I/me/my", no clichés ("hard-working", "team player", "passionate", "motivated", "dynamic", "results-driven", "responsible for"), no em dashes. State the role, the scope already evidenced, core strengths and one or two real achievements from the FACTS.
- Bullets: each starts with a strong past-tense action verb (present tense for a current role is fine), 8–30 words, no "I/my", no clichés, and no verb starts more than two bullets in a role. Lead with the result where the bullet has one. Return at least 3 bullets per role when the existing bullets contain enough distinct facts to split or expand; never pad with filler. Keep every number exactly as written.
- Skills: return named groups (e.g. "Languages", "Frameworks", "Tools", "Domain") with no duplicates and at most 30 skills in total, most relevant first. Keep the candidate's existing skills (drop only duplicates and obvious filler) and add a skill only when the FACTS clearly show it (e.g. a tool named in a bullet).
- Headline: a short job title. When a TARGET JOB is given and the candidate's experience fits it, use the job's title wording; otherwise keep their own title.
- When a TARGET JOB is given, use its exact wording for skills and tools the candidate demonstrably has — never for ones they don't.

FACTUAL BOUNDARY (do not cross this):
- Never invent an employer, title, date, number, metric, percentage, team size, tool, technology, certification or achievement that isn't in the FACTS.
- If a bullet has no number, do not add one — make it sharper instead.
- Never change role titles, companies or dates.

Respond with a single compact JSON object with ONLY the keys for the parts you were asked to rewrite:
- "summary": string
- "roles": array of {"index": number, "bullets": string[]}
- "skillGroups": array of {"category": string, "items": string[]}
- "headline": string`;

// Reasoning models spend extra (billed) tokens "thinking" before producing
// the JSON body, which can take noticeably longer than a plain completion —
// especially for a long resume/CV. 15s was cutting some of these off
// mid-generation.
const REQUEST_TIMEOUT_MS = 45_000;
// Role matching sits in the user's path at the end of a flow — fail fast and
// fall back to the deterministic match rather than keep them waiting.
const ROLE_MATCH_TIMEOUT_MS = 8_000;

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/** Which OpenAI-compatible endpoint to talk to (see ./index.ts). */
export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Sent as reasoning_effort when set; omit for models that reject it. */
  reasoningEffort?: ReasoningEffort;
  /** Cap on a CV generation's reply (reasoning tokens count toward it on most providers). */
  maxOutputTokens: number;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

// A fixed temperature made low and high enhancementLevel requests sample almost
// identically, undercutting the rule text's instructed difference in writing
// intensity. Scale modestly with enhancementLevel instead: low levels stay
// near-deterministic (close paraphrase of the source), high levels get enough
// room to actually take the liberty the enhancement rules grant them. The
// range stays well short of "creative" territory — the JSON schema and the
// anti-hallucination rules constrain the output regardless of temperature.
function temperatureForEnhancementLevel(enhancementLevel: number): number {
  return Math.round((0.3 + enhancementLevel * 0.3) * 100) / 100;
}

const issueLines = (issues: ScoreIssue[]) => issues.map((i) => `- ${i.label}: ${i.message}`).join("\n");

function jobBlock(job?: JobRequirements): string {
  if (!job || !job.title) return "";
  return [
    `TARGET JOB: ${job.title}${job.seniority ? ` (${job.seniority})` : ""}`,
    job.requiredSkills.length ? `Required: ${job.requiredSkills.join(", ")}` : "",
    job.preferredSkills.length ? `Preferred: ${job.preferredSkills.join(", ")}` : "",
    job.keywords.length ? `Other keywords: ${job.keywords.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const stringList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

/**
 * Provider mechanics only: sends the request to any OpenAI-compatible chat
 * API (Groq, Gemini…), configures the model, and parses the response. All CV
 * business rules (what the model is told to do) live in ./cv/rules and
 * ./cv/prompts — this class must not contain any.
 */
const ROLE_MATCH_SYSTEM_PROMPT = `You compare job roles. You get a NEW ROLE and a numbered list of a candidate's EXISTING ROLES. For each existing role decide:
- "same": the same job under a different name, spelling, seniority or tech focus (e.g. "React Developer" and "Frontend Engineer"; "Sr. Accountant" and "Accountant").
- "related": a different job that overlaps a lot (e.g. "Backend Engineer" and "Full-stack Engineer"; "Data Analyst" and "Data Scientist").
- leave it out when it is a different profession.
Respond with a single JSON object: {"matches":[{"index":<number>,"relation":"same"|"related"}]}. At most one role can be "same". No other text.`;

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;

  constructor(private config: OpenAICompatibleConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  private reasoningParams(): { reasoning_effort?: ReasoningEffort } {
    return this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {};
  }

  async generateCV(input: AIGenerateInput): Promise<AnalyzeResult | RoleMismatch> {
    const { system, user } = buildCvGenerationPrompt(input);

    const completion = await trackAiCall("cv_generation", this.config.model, () =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: temperatureForEnhancementLevel(input.enhancementLevel),
          max_tokens: this.config.maxOutputTokens,
          ...this.reasoningParams(),
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );

    const raw = completion.choices[0]?.message?.content ?? "";
    const cleaned = stripJsonFences(raw);

    try {
      return JSON.parse(cleaned) as AnalyzeResult | RoleMismatch;
    } catch {
      throw new Error("AI provider returned invalid JSON");
    }
  }

  async classifyRoleMatch(input: RoleMatchInput): Promise<RoleMatch[]> {
    if (input.profiles.length === 0) return [];
    const list = input.profiles.map((p, i) => `${i + 1}. ${p.title}`).join("\n");
    const completion = await trackAiCall("role_match", this.config.model, () =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: "system", content: ROLE_MATCH_SYSTEM_PROMPT },
            { role: "user", content: `NEW ROLE: ${input.role}\n\nEXISTING ROLES:\n${list}` },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          // Room for reasoning models' hidden reasoning tokens; kept at the lowest effort.
          max_tokens: 800,
          ...(this.config.reasoningEffort ? { reasoning_effort: "low" as ReasoningEffort } : {}),
        },
        { timeout: ROLE_MATCH_TIMEOUT_MS }
      )
    );

    let parsed: { matches?: unknown };
    try {
      parsed = JSON.parse(stripJsonFences(completion.choices[0]?.message?.content ?? "{}"));
    } catch {
      throw new Error("AI provider returned invalid JSON");
    }
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const result: RoleMatch[] = [];
    for (const m of matches) {
      const index = Number((m as { index?: unknown }).index) - 1;
      const relation = (m as { relation?: unknown }).relation;
      const profile = input.profiles[index];
      if (!profile || (relation !== "same" && relation !== "related")) continue;
      // Never trust more than one "same" — demote the rest.
      const sameTaken = result.some((r) => r.relation === "same");
      result.push({ profileId: profile.id, relation: relation === "same" && !sameTaken ? "same" : "related" });
    }
    return result;
  }

  async polishSummary(input: PolishSummaryInput): Promise<string> {
    const contextLines = [
      input.title ? `Target title: ${input.title}` : null,
      input.skills?.length ? `Key skills: ${input.skills.join(", ")}` : null,
      input.experienceBullets?.length
        ? `Experience highlights:\n${input.experienceBullets.map((b) => `- ${b}`).join("\n")}`
        : null,
    ].filter(Boolean);

    const userMessage = [
      `DRAFT SUMMARY:\n${input.summary}`,
      contextLines.length ? `\nSUPPORTING CONTEXT (for grounding only — do not introduce facts from here that the draft doesn't already convey unless they're simply confirming what's implied):\n${contextLines.join("\n")}` : "",
    ].join("\n");

    const completion = await trackAiCall("polish_summary", this.config.model, () =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: "system", content: POLISH_SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          temperature: 0.4,
          ...this.reasoningParams(),
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch {
      throw new Error("AI provider returned invalid JSON");
    }

    const polished = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!polished) {
      throw new Error("AI provider returned an empty summary");
    }
    return polished;
  }

  /** One JSON-mode call: system + user message in, parsed object out. */
  private async jsonCall(
    operation: AiOperation,
    system: string,
    user: string,
    options: { temperature: number; maxTokens?: number }
  ): Promise<Record<string, unknown>> {
    const completion = await trackAiCall(operation, this.config.model, () =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: options.temperature,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...this.reasoningParams(),
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    try {
      const parsed: unknown = JSON.parse(stripJsonFences(completion.choices[0]?.message?.content ?? "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // handled below
    }
    throw new Error("AI provider returned invalid JSON");
  }

  async analyzeJobDescription(jobDescription: string): Promise<JobRequirements> {
    // Temperature 0: the result is stored and drives the score, so it should be as repeatable as the model allows.
    const parsed = await this.jsonCall("jd_analysis", JOB_ANALYSIS_SYSTEM_PROMPT, `JOB DESCRIPTION:\n${jobDescription}`, {
      temperature: 0,
      maxTokens: 2000,
    });
    return {
      title: typeof parsed.title === "string" ? parsed.title.trim().slice(0, 200) : "",
      seniority: typeof parsed.seniority === "string" ? parsed.seniority.trim().slice(0, 40) : "",
      requiredSkills: stringList(parsed.requiredSkills, 15).map((s) => s.slice(0, 80)),
      preferredSkills: stringList(parsed.preferredSkills, 10).map((s) => s.slice(0, 80)),
      keywords: stringList(parsed.keywords, 15).map((s) => s.slice(0, 80)),
    };
  }

  async reviewCv(input: ReviewCvInput): Promise<ReviewTip[]> {
    const user = [
      `CV:\n${input.cvText}`,
      jobBlock(input.job),
      input.issues.length ? `ISSUES ALREADY FLAGGED:\n${issueLines(input.issues)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const parsed = await this.jsonCall("cv_review", CV_REVIEW_SYSTEM_PROMPT, user, { temperature: 0.2, maxTokens: 2000 });
    const sections = new Set(["personal", "summary", "experience", "education", "skills", "general"]);
    const tips = Array.isArray(parsed.tips) ? parsed.tips : [];
    return tips
      .map((t) => {
        const tip = (t ?? {}) as { section?: unknown; text?: unknown };
        const section = typeof tip.section === "string" && sections.has(tip.section) ? tip.section : "general";
        return { section, text: typeof tip.text === "string" ? tip.text.trim().slice(0, 500) : "" };
      })
      .filter((t) => t.text)
      .slice(0, 6);
  }

  async polishCv(input: PolishCvInput): Promise<PolishCvResult> {
    const parts: string[] = [];
    if (input.summary !== undefined) parts.push(`SUMMARY (rewrite):\n${input.summary || "(empty — write one from the FACTS)"}`);
    if (input.headline !== undefined) parts.push(`HEADLINE (rewrite):\n${input.headline || "(empty)"}`);
    if (input.skills) parts.push(`SKILLS (regroup and clean up):\n${input.skills.join(", ") || "(none — list the ones the FACTS show)"}`);
    for (const role of input.roles ?? []) {
      parts.push(`ROLE index ${role.index} — ${role.role} at ${role.company} (rewrite bullets):\n${role.bullets.map((b) => `- ${b}`).join("\n")}`);
    }
    const user = [
      `FACTS (the whole CV):\n${input.cvText}`,
      jobBlock(input.job),
      input.issues.length ? `ISSUES TO FIX:\n${issueLines(input.issues)}` : "",
      `PARTS TO REWRITE:\n${parts.join("\n\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const parsed = await this.jsonCall("cv_polish", CV_POLISH_SYSTEM_PROMPT, user, {
      temperature: 0.3,
      maxTokens: this.config.maxOutputTokens,
    });

    const result: PolishCvResult = {};
    if (input.summary !== undefined && typeof parsed.summary === "string" && parsed.summary.trim()) {
      result.summary = parsed.summary.trim();
    }
    if (input.headline !== undefined && typeof parsed.headline === "string" && parsed.headline.trim()) {
      result.headline = parsed.headline.trim();
    }
    if (input.skills && Array.isArray(parsed.skillGroups)) {
      result.skillGroups = parsed.skillGroups
        .map((g) => {
          const group = (g ?? {}) as { category?: unknown; items?: unknown };
          return { category: typeof group.category === "string" ? group.category.trim() : "", items: stringList(group.items, 40) };
        })
        .filter((g) => g.items.length > 0);
    }
    if (input.roles?.length && Array.isArray(parsed.roles)) {
      const wanted = new Set(input.roles.map((r) => r.index));
      result.roles = parsed.roles
        .map((r) => {
          const role = (r ?? {}) as { index?: unknown; bullets?: unknown };
          return { index: Number(role.index), bullets: stringList(role.bullets, 12) };
        })
        .filter((r) => wanted.has(r.index) && r.bullets.length > 0);
    }
    return result;
  }
}
