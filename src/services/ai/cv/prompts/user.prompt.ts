import type { AIGenerateInput } from "../../provider.interface";
import { getEnhancementReminder } from "../rules/enhancement.rules";

/**
 * Builds the user message: the actual candidate data plus tailoring/identity
 * context. All rule text lives in system.prompt.ts — this only ever carries
 * data, so rules can't drift into being duplicated per-request.
 */
export function buildUserMessage(input: AIGenerateInput): string {
  const identityBlock =
    input.userIdentity?.name || input.userIdentity?.email
      ? `IDENTITY (authoritative — copy exactly, do not alter, infer, or replace)
Full name: ${input.userIdentity.name ?? "(not provided — extract from source material)"}
Email: ${input.userIdentity.email ?? "(not provided — extract from source material)"}

`
      : "";

  const defaults = input.profileDefaults;
  const profileLines = defaults
    ? [
        defaults.full_name && `Full name: ${defaults.full_name}`,
        defaults.email && `Email: ${defaults.email}`,
        defaults.phone && `Phone: ${defaults.phone}`,
        defaults.professions?.length &&
          `Professions (main first): ${defaults.professions.join("; ")} — when the source material doesn't state a headline, use the one that best fits the job description (the main one if there's none)`,
      ].filter(Boolean)
    : [];
  const profileBlock = profileLines.length
    ? `ACCOUNT PROFILE (the candidate's saved contact details — use each one ONLY when the source material doesn't state it; the source always wins. Never ask a clarification question about a detail listed here.)
${profileLines.join("\n")}

`
    : "";

  const jobDescriptionBlock = input.jobDescription?.trim()
    ? `${input.jobDescription.trim()}\n\n(This job description is for tailoring and relevance only. It is NEVER evidence of the candidate's own experience, skills, or qualifications — see the SOURCE PRIORITY and "job description is not candidate data" rules.)`
    : "No job description was provided. Generate a strong general professional CV.";

  const sectionsList = input.optionalSections.length > 0 ? input.optionalSections.join(", ") : "none";
  const templateNotesBlock = input.templateNotes?.trim()
    ? `\nTemplate notes (follow these for this template, within every rule above): ${input.templateNotes.trim()}`
    : "";

  // Kept separate from SOURCE INFORMATION and placed near the end (same
  // recency-weighted placement as the enhancement REMINDER below) so it
  // reads as a directive to follow, not more candidate narrative to extract
  // facts from — only present when actually set, so this costs nothing when
  // the caller has no specific focus.
  const focusBlock = input.focusInstructions?.trim()
    ? `\n\nUSER'S ENHANCEMENT FOCUS (high priority — emphasize and rewrite toward this within the FACTUAL BOUNDARY; never invent facts to satisfy it)\n${input.focusInstructions.trim()}`
    : "";

  const base = `${identityBlock}${profileBlock}SOURCE INFORMATION
${input.sourceText}

JOB DESCRIPTION
${jobDescriptionBlock}

TEMPLATE
Template: ${input.templateName ?? input.templateId}
Optional sections this template shows: ${sectionsList}
Return these optional sections only when relevant information exists in the source material, and no other optional sections.${templateNotesBlock}${focusBlock}

REMINDER: ${getEnhancementReminder(input.enhancementLevel)}`;

  if (!input.repairNotes) return base;

  return `${base}

PREVIOUS ATTEMPT FAILED VALIDATION
Your previous response did not match the OUTPUT SCHEMA. Specific problems:
${input.repairNotes}

Return a corrected JSON object that fixes exactly these problems — use the OUTPUT SCHEMA's exact field names (see STRICT SHAPE RULES). Do not change any information that was already correct, and do not add commentary.`;
}
