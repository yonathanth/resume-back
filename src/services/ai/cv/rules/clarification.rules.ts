/**
 * When and what the model should ask. The goal is a genuinely strong CV, so
 * the model asks for missing hard facts and for the details that would most
 * deepen the content. The frontend shows questions three per screen, so up to
 * seven is comfortable. The backend also guarantees questions for missing
 * personal fields and for entries missing their name/dates — see
 * validateGeneratedCv.ts.
 */
export const MAX_CLARIFICATION_QUESTIONS = 7;

export function getClarificationRules(): string {
  return `CLARIFICATION QUESTIONS

Ask what you need to make this a strong, complete CV — up to ${MAX_CLARIFICATION_QUESTIONS} questions, most important first. Ask none only when the material is already complete and specific.

THE GOLDEN RULE: if the material gives it, use it as given and don't ask about it. Only ask about what is missing or genuinely unclear. Never ask the candidate to "confirm", "verify" or "double-check" anything the material already states — a school name, degree, title, company or date written in the CV is the answer, even if it is informal or abbreviated (use it as written). The only exception is a real contradiction in the material (e.g. two different end dates for the same job): then ask which one is right, quoting both.

ALWAYS ASK (highest priority)
- For every experience, education or project entry missing a HARD FACT: the company / school / organisation name, the candidate's title or degree, and the dates. Ask ONE combined question per entry, naming it so the candidate knows which one you mean:
  "About your role at the software and marketing company during university: what was the company called, what was your job title, and when did you start and finish?"
  Ask only for the facts that are actually missing. If the material already names the company (e.g. "Shalops"), don't ask where they worked; ask only what's left: "When did you start and finish at Shalops?"
- The candidate's name, email or headline, only if the material and the ACCOUNT PROFILE don't give them.

THEN ASK TO DEEPEN (use the remaining slots)
Questions whose answers would make bullets noticeably stronger, e.g.:
- Scale and results: "Roughly how many gyms or members used the system you built?", "How many interns did you lead?"
- Specifics: "Which payment providers did you integrate?", "Where did you deploy (AWS, a VPS, Vercel…)?"
- Direction, when unclear: "Which role are you aiming for next — backend, full-stack, or something else?"

DON'T ASK
- About anything in the ACCOUNT PROFILE.
- For a fact the material already states (a company, school, title or date it gives) — not even to confirm it or to get its "exact" or "full" form.
- Style or formatting preferences.
- More than one question about the same entry — combine them.

FORMAT
Each question: a stable short "id" (lower_snake_case, e.g. "marketing_company_details"), the "question" in plain, friendly language, a one-sentence "reason" shown to the candidate, a "type" ("text" | "textarea" | "select" | "date" — use "textarea" for combined questions), "required" (true only for the candidate's name or email — everything else is optional so they can skip what they don't know), and "options" (only for "select").`;
}
