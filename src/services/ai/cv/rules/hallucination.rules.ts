/**
 * The line between building on the candidate's material (encouraged — they
 * edit the draft afterwards) and inventing verifiable facts (never allowed —
 * those are asked for instead). Enhancement level and tailoring can change
 * how much gets built out, but never move this line.
 */
export function getHallucinationRules(): string {
  return `ANTI-HALLUCINATION RULES

HARD FACTS — never invent, at any enhancement level
These are verifiable, and a made-up one can embarrass the candidate in an interview or background check:
- Names of employers, clients, schools, universities, organisations, products the candidate didn't name.
- Degrees, fields of study, grades/GPA, courses, honors.
- Certifications, licences, awards, publications, patents.
- Start/end dates and years of experience.
- Email, phone, location, and any link (LinkedIn, GitHub, portfolio).
- Spoken languages and their proficiency.
Dates: never make one up, estimate one, or work one out from other details. Use only dates the candidate wrote.
Honors (e.g. "Summa Cum Laude", "Dean's List", "First-class honours"): only when the candidate wrote them. Never derive one from a GPA or grade.
When a hard fact is missing, OMIT that field (never a placeholder like "Tech Company", "Independent Projects", "University", "2021") and ask a clarification question for it.

MISSING HARD FACTS NEVER REMOVE AN ENTRY
If the candidate describes a real job, internship, freelance/university role, project or degree but doesn't name it or date it, still include the entry with everything you can write — role, bullets, technologies — and leave out only the unknown fields. Then ask for them.
  Source: "During university I worked with a small software and marketing company where I helped manage projects and develop software."
  Right: an experience entry with a role (e.g. "Software Developer") and detailed bullets, company and dates omitted, plus one question asking for the company name, the job title they held, and the dates.
  Wrong: leaving the job out of "experience" because the company wasn't named.
The same applies to education ("I studied computer engineering" → an education entry with field "Computer Engineering", degree inferred where clear like "BSc", institution and dates omitted and asked for).

WHAT YOU MAY BUILD ON (soft content — write it out richly)
- Responsibilities, tasks and deliverables that ordinarily come with the work described.
- Technologies, tools and practices clearly implied by the work (REST APIs for API work, Git for GitHub use, CI/CD for deployment work, database design for PostgreSQL backends).
- Scope, collaboration and impact framed favourably (clients served, features shipped, systems owned, people mentored).
- Conservative, plausible figures where they fit the work (e.g. "mentored 3 interns", "integrated 2 payment providers") — prefer asking for real numbers when a figure would be central to a bullet.
- Role titles: when the candidate describes the work but not the title, use an accurate, conventional title for that work ("Software Developer", "Project Coordinator") — and ask them to confirm it.

SKILLS
Include skills named in the material plus those clearly demonstrated by it (see above). Never add a skill only because the job description mentions it.

OPTIONAL SECTIONS
Emit an optional section only if the template supports it AND the material gives something for it. Projects described in the material always go in "projects" when the template supports it — give each a short descriptive name ("Gym Management System") when the candidate didn't name it.`;
}
