/**
 * Job-description tailoring rules. The job description is optional context
 * for relevance and wording — see the SOURCE PRIORITY rule in core.rules.ts,
 * which already ranks it last and excludes it as candidate evidence. This
 * module elaborates on how tailoring should work in practice: it must be an
 * actual analysis of job requirements against candidate evidence, not a
 * generic rewrite that ignores the job description or a keyword-stuffing
 * pass that copies its terms into the candidate's data.
 */
export function getTailoringRules(): string {
  return `TAILORING RULES

If no job description is provided: generate a strong professional CV aimed at the role the candidate says they want next (e.g. "I want a senior accountant role"), or, when they don't say, at the direction of their most recent role — lead the headline, summary, skills order and bullet order with what matters most for that role — and skip the rest of this section.

If a job description is provided, first run the ROLE COMPATIBILITY CHECK below. Only if it passes do you proceed to the two tailoring steps: first analyze the job, then align the candidate's ACTUAL information with it.

ROLE COMPATIBILITY CHECK — do this before anything else
Decide whether the candidate's actual background gives a genuine, honest starting point for this job. The bar for rejecting is HIGH: when in doubt, do NOT reject — write the CV and let Step 2 report the requirements the candidate doesn't show as gaps.

It is NOT a mismatch (proceed to Step 1 normally) when:
- It's the same field, at any level of fit: a Frontend Developer applying to a Backend or Full-Stack role, a junior candidate applying to a senior posting.
- It's an adjacent or common career move where real skills carry over, even if the job title is new to the candidate: Teacher → Instructional Designer or Corporate Trainer; Customer Support → Customer Success, QA or Account Manager; Retail or Hospitality → Sales or Customer Service; Nurse → Healthcare Administration or Clinical Research Coordinator; Software Developer → Product Manager, Solutions Engineer or Technical Writer; Accountant → Financial Analyst or Operations; Graphic Designer → UI/UX Designer or Marketing.
- A meaningful part of the job's core duties (people management, client handling, data analysis, writing, project coordination, a shared tool or domain) is something the candidate has actually done.

It IS a mismatch only when the job's core duties belong to a fundamentally different profession that requires training, licensing or expertise the candidate shows no sign of, so that their real experience gives almost nothing to build a genuine, tailored CV from: e.g. Frontend Developer → Financial Accountant (CPA), Registered Nurse → Software Engineer, Graphic Designer → Civil Engineer, Cloud Engineer → Real-Estate Sales Agent.

If it IS a genuine mismatch, do not produce a CVContent object at all. Respond with ONLY this JSON object instead (see OUTPUT SCHEMA for the exact shape):
  Candidate: Frontend Developer with React/TypeScript experience only.
  Job: Financial Accountant requiring CPA certification, financial reporting, and Excel-based modeling.
  Output: { "mismatch": true, "reason": "Your experience is in frontend development, and this role is in financial accounting.", "missing": ["CPA certification", "Financial reporting", "Excel financial modeling", "GAAP knowledge"] }
"reason" is shown to the candidate: ONE short, plain sentence addressed to them ("Your experience is in X, and this role is in Y."), no more than 25 words, never judgmental. "missing" must list 3 to 6 specific, concrete requirements taken from the job description that the candidate's source material gives no evidence of (the same standard as NO MATCH in Step 2 below), each a short label of at most 6 words — not vague statements. Do not include a "reason" or "missing" list that references facts about the candidate beyond what the source material actually contains.

Do not use the mismatch response merely because the candidate is a weak or partial fit within the same field — that case is handled honestly below and still produces a real CV.

STEP 1 — ANALYZE THE JOB DESCRIPTION
Before writing anything, identify from the job description text:
- Required technical skills and preferred/nice-to-have technical skills (these are different — do not treat a "nice to have" as mandatory).
- Years of experience or seniority level expected.
- Core responsibilities and domain knowledge.
- Tools, platforms, and soft skills mentioned.
- Education or certification requirements, and important recurring terminology.

STEP 2 — CLASSIFY THE CANDIDATE'S EVIDENCE AGAINST EACH REQUIREMENT
For each requirement identified above, decide which of these three categories applies, using only the candidate's SOURCE INFORMATION (never the job description itself) as evidence:
- STRONG MATCH: the candidate explicitly has this skill or experience. → Emphasize it prominently — lead with it in the summary and skills ordering, and give its bullets more detail and prominence.
- TRANSFERABLE MATCH: the candidate has related, adjacent experience that reasonably supports the requirement without being the same thing. → Highlight the transferable angle honestly (e.g. frame it as "experience with X, a closely related technology/responsibility to Y") — do not phrase it as if it were direct experience with the requirement itself.
- NO MATCH: there is no evidence in the source for this requirement. → Do not fabricate it, do not imply it, and do not stretch a transferable match into a false direct one just to appear more complete. It is correct and expected for a CV to leave some job requirements unaddressed — prioritize presenting the candidate's strongest genuinely relevant experience over attempting to make every requirement appear satisfied.

Collect every NO MATCH requirement (short and specific, e.g. "AWS certification" not "cloud skills") into the response's jobAnalysis.gaps array — see OUTPUT SCHEMA. This only applies when a job description was actually provided and this is not the full ROLE COMPATIBILITY CHECK mismatch case above; when everything is STRONG or TRANSFERABLE MATCH, gaps may be omitted or empty. When no job description was provided at all, jobAnalysis must be null, not an object.

DETAILS THE CANDIDATE CONFIRMED FOR THIS JOB
The SOURCE INFORMATION may end with a block headed "Details the candidate confirmed after reviewing the job's requirements". These are requirements the candidate was told their CV didn't show, and then said they do have — each line names the requirement and, when given, the candidate's own detail about it. They are the candidate's own statements, so they ARE candidate evidence (unlike the job description itself):
- Every confirmed requirement MUST appear in the CV — none may be dropped. Requirements from the job that are NOT in this block stay governed by the NO MATCH rule above and must not be added.
- Treat each confirmed requirement as a STRONG MATCH and work it into the section where it naturally belongs — a tool or skill into skills, a certification into certifications (or the summary/skills when the template has no certifications section), a responsibility or achievement into the most fitting experience entry's bullets — and mention it in the summary when it is central to the job.
- Use only what the line actually says. When the candidate gave no detail ("no further detail given"), state the bare skill or qualification; never add an employer, date, duration, level, number, or outcome they did not give, and never attach it to a specific role unless their detail names that role.
- Do not list a confirmed requirement in jobAnalysis.gaps again.
- Write it exactly like the rest of the CV — plain text, no "**", asterisks, or any other marking that it was added.

THE JOB DESCRIPTION IS NOT CANDIDATE DATA
Never treat requirements, responsibilities, technologies, qualifications, or achievements mentioned in the job description as facts about the candidate. If the job description says "5 years of experience required," that does not mean the candidate has 5 years of experience. The job description is used only to determine relevance, classification, and tailoring — never as a source of candidate facts.

JOB MATCHING WITHOUT FABRICATION
A candidate does not need to be a perfect match.
  Candidate: "Built React applications."
  Job requires: React, TypeScript, Jest, Redux.
  Classification: React = STRONG MATCH; TypeScript/Jest/Redux = NO MATCH (not in source).
  Correct output: "Developed React-based web applications with experience building reusable frontend functionality." Do NOT add TypeScript, Jest, or Redux.

KEYWORD OPTIMIZATION
Use terminology from the job description only when the candidate's source information actually supports it (i.e. only for STRONG or TRANSFERABLE MATCH items). Do not keyword-stuff or repeat the same keyword unnaturally — the CV must read naturally. Prioritize semantic relevance over keyword density.

SKILLS
Skills come from the candidate's material (named or clearly demonstrated by it). Do not add a technology merely because it appears in the job description. When tailoring, put STRONG MATCH skills first.
  Candidate skills: React, JavaScript, CSS, Node.js. Job wants: React, TypeScript, AWS, Docker.
  Correct output: React, JavaScript, CSS, Node.js (with React first). Do NOT add TypeScript, AWS, or Docker.

PROFESSIONAL SUMMARY
This is the most strongly tailored section. Without a job description, base it on the candidate's experience, skills, and career profile. With a job description, lead with STRONG MATCH strengths, then genuinely relevant TRANSFERABLE MATCH framing — never claim a qualification the candidate does not possess. Avoid generic filler such as "highly motivated professional with a passion for success" or "seeking to apply my skills"; prefer concrete, specific professional positioning grounded in the candidate's real background.

HOW TAILORING AFFECTS PRIORITIZATION
Job relevance changes emphasis, not honesty. It may affect: professional summary framing, skills ordering, experience and bullet ordering (put the most job-relevant role/bullets first), and how much detail a relevant bullet gets versus a less relevant one. It must NOT cause you to omit or hide truthful candidate information just because it's less relevant to this job — the only case where an entire section is left out is the existing OPTIONAL SECTIONS rule (an optional section with no supporting source information is returned empty, per hallucination.rules.ts), never a required section like experience or education.

WHEN THE JOB IS A WEAK BUT RELATED FIT
A weak overall fit within the same field (see ROLE COMPATIBILITY CHECK above — this is NOT the mismatch case) must be reflected honestly, not manufactured away.
  Candidate: Frontend Developer with React experience only.
  Job: Backend Developer requiring Node.js, PostgreSQL, and API design.
  Do NOT invent backend framework experience, database design experience, or API architecture work — none of that exists in the source.
  Do genuinely note transferable strengths only where the source actually supports them, e.g. JavaScript fundamentals, experience consuming APIs from the frontend, or general software engineering practices evident from the candidate's real work — framed honestly as transferable, never as direct backend experience.

HOW FAR TO TAILOR
Tailor to the job the same way at every enhancement level: restructure around job relevance — the most job-relevant bullet in each role comes first, and every STRONG/TRANSFERABLE-match bullet uses the job's terminology where the candidate's source genuinely supports it (not just reordered). The enhancement level below only decides how much liberty to take in the wording, restructuring, and bullet-merging used while writing about that selected information.`;
}
