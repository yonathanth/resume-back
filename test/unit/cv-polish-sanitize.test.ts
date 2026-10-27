import { describe, expect, it } from "vitest";
import {
  allPolishTargets,
  applyPolishPatch,
  buildPolishInput,
  currentJobAnalysis,
  hashJobDescription,
  numbersAreGrounded,
  sanitizePolish,
  scoreCv,
} from "../../src/services/score/score.service";

const content = {
  personal: { full_name: "Sam", title: "Engineer", email: "sam@example.com" },
  summary: "Engineer who builds things.",
  experience: [
    {
      company: "Acme",
      role: "Engineer",
      start_date: "2020-01",
      end_date: "present",
      bullets: [{ text: "Worked on the billing system, reducing failed payments by 30%" }, { text: "Helped with Docker deploys" }],
    },
    { company: "Beta", role: "Intern", start_date: "2019-01", end_date: "2019-06", bullets: [] },
  ],
  skills: ["JavaScript", "React", "Node.js", "SQL"],
};

describe("buildPolishInput", () => {
  it("only sends roles that have bullets to rewrite", () => {
    const input = buildPolishInput(content, [{ kind: "bullets" }], scoreCv(content), null);
    expect(input.roles?.map((r) => r.index)).toEqual([0]);
    expect(input.cvText).not.toContain("sam@example.com");
  });

  it("'all' covers every AI-fixable target once", () => {
    const kinds = allPolishTargets(scoreCv(content)).map((t) => t.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual(expect.arrayContaining(["summary", "bullets", "skills"]));
  });
});

describe("sanitizePolish", () => {
  const input = buildPolishInput(content, [{ kind: "summary" }, { kind: "bullets" }, { kind: "skills" }], scoreCv(content), null);

  it("drops rewrites that invent numbers", () => {
    const patch = sanitizePolish(content, input, {
      summary: "Engineer who cut failed payments by 45% across 3 teams.",
      roles: [{ index: 0, bullets: ["Reduced failed payments by 30% by rebuilding billing retries", "Grew revenue 200%"] }],
    });
    expect(patch.summary).toBeUndefined();
    expect(patch.experience).toBeUndefined();
  });

  it("keeps grounded rewrites and ignores roles that weren't asked for", () => {
    const patch = sanitizePolish(content, input, {
      summary: "Engineer who rebuilt billing to reduce failed payments by 30%.",
      roles: [
        { index: 0, bullets: ["Reduced failed payments by 30% by rebuilding billing retries", "Automated Docker deploys for the team"] },
        { index: 1, bullets: ["Invented an intern achievement"] },
      ],
    });
    expect(patch.summary).toBe("Engineer who rebuilt billing to reduce failed payments by 30%.");
    expect(patch.experience).toEqual([
      { index: 0, bullets: ["Reduced failed payments by 30% by rebuilding billing retries", "Automated Docker deploys for the team"] },
    ]);
  });

  it("keeps only skills the CV already lists or mentions", () => {
    const patch = sanitizePolish(content, input, {
      skillGroups: [
        { category: "Languages", items: ["JavaScript", "SQL", "Rust"] },
        { category: "Tools", items: ["React", "Node.js", "Docker", "react"] },
      ],
    });
    expect(patch.skillGroups).toEqual([
      { category: "Languages", items: ["JavaScript", "SQL"] },
      { category: "Tools", items: ["React", "Node.js", "Docker"] },
    ]);
  });

  it("rejects a skills rewrite that drops most existing skills", () => {
    const patch = sanitizePolish(content, input, { skillGroups: [{ category: "Tools", items: ["Docker"] }] });
    expect(patch.skillGroups).toBeUndefined();
  });

  it("applies a patch for the projected score", () => {
    const next = applyPolishPatch(content, { experience: [{ index: 0, bullets: ["Led billing"] }], skillGroups: [{ category: "A", items: ["SQL"] }] });
    expect((next.experience as { bullets: unknown[] }[])[0].bullets).toEqual([{ text: "Led billing" }]);
    expect(next.skills).toEqual(["SQL"]);
    expect(content.experience[0].bullets).toHaveLength(2); // original untouched
  });
});

describe("job analysis cache", () => {
  it("is only current for the same job description", () => {
    const stored = { jdHash: hashJobDescription("Backend  engineer\n needed"), data: { title: "Backend engineer", seniority: "", requiredSkills: [], preferredSkills: [], keywords: [] } };
    expect(currentJobAnalysis(" Backend engineer needed ", stored)).not.toBeNull();
    expect(currentJobAnalysis("Frontend engineer needed", stored)).toBeNull();
    expect(currentJobAnalysis(null, stored)).toBeNull();
    expect(currentJobAnalysis("Backend engineer needed", { bogus: true })).toBeNull();
  });

  it("numbersAreGrounded compares numbers, ignoring thousands separators", () => {
    expect(numbersAreGrounded("Served 1,200 users", "served 1200 users")).toBe(true);
    expect(numbersAreGrounded("Served 1,300 users", "served 1200 users")).toBe(false);
  });
});
