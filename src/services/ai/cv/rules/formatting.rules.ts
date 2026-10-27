/**
 * Output-shape and output-format rules — the mechanical contract the AI's
 * JSON must satisfy. These are the most common ways generated output gets
 * rejected by backend validation, so they're stated explicitly rather than
 * left implicit in the schema alone.
 */
export function getFormattingRules(topLevelKeys: string[]): string {
  return `OUTPUT FORMAT RULES
Return ONLY a single valid JSON object matching the OUTPUT SCHEMA below, using exactly those top-level fields and no others. Never output markdown, code fences, explanations, analysis, recommendations, notes, disclaimers, or commentary of any kind — the response must start with { and end with }. Generate content that can be placed directly inside a real CV; never narrate about the person or the generation process, never address the user directly, and never discuss whether the candidate is qualified.

LANGUAGE
Write every piece of CV text, and every clarification question, in English — whatever language the source uses (it may be Amharic, English, or a mix of both). Translate the meaning faithfully; translating is not inventing. Proper names the candidate already wrote in Latin letters keep their spelling; names written only in Ge'ez script are transliterated using their common English spelling (e.g. "አዋሽ ባንክ" → "Awash Bank", "አዲስ አበባ ዩኒቨርሲቲ" → "Addis Ababa University").

STRICT SHAPE RULES
- Use exactly these top-level keys, spelled exactly this way: ${topLevelKeys.join(", ")}. Do not add, remove, rename, or nest them under another key (no "data", "cv", or "resume" wrapper object).
- Every field name inside each object must match the OUTPUT SCHEMA exactly. Do NOT substitute common resume-JSON conventions for this app's field names:
  - use "full_name", not "name"
  - use "role", not "position" or "jobTitle"
  - use "start_date" / "end_date", not "startDate" / "endDate"
  - use "bullets", not "highlights" or "achievements"
  - use "field", not "area" or "fieldOfStudy"
  - use "honors", not "achievements"
  - "skills" must be a JSON array of plain strings, e.g. ["React", "Node.js"] — never an array of objects like {"name": "React"}.
  - Every bullet (in experience and projects) is an object {"text": "..."} or {"label": "...", "text": "..."} — never a bare string. When an experience or project entry has 2 or more bullets, give every one of its bullets a "label": the 2-4 word theme a recruiter would scan for (e.g. "Payments", "Team Leadership", "Scale"). Labels must be supported by the bullet itself and never repeat its text. An entry with a single bullet has no label.
  - When there are 6 or more skills, also return "skillGroups": 2-6 short, conventional categories (e.g. "Languages", "Frontend", "Backend", "Infrastructure"). Every skill in "skills" appears in exactly one group, and groups contain nothing that isn't in "skills". With fewer skills, omit "skillGroups".
- "experience" and "education" are always JSON arrays of objects, even when there is only one entry.
- "personal", "experience" (at least 1 entry), and "skills" (at least 1 entry) are required and must never be empty or omitted — extract them from the source material. "personal" is always an object, but any of its fields the source doesn't provide are simply left out of it.
- NEVER use null or an empty string ("") as a value. When a field's value is unknown, omit the key entirely. Always derive "title" from the material (see HEADLINE). When full_name or email is unknown, omit it and ask for it instead.
- Only include an optional top-level field if it is listed in TEMPLATE below AND the source material actually supports it; omit every other optional field entirely. Use an empty array for a supported list section with no supporting information — never invent entries to fill it.`;
}
