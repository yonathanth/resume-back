import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SCORE_RULES_VERSION, scoreCv, type ScoreInput, type ScoreJobRequirements } from "../../src/services/score/engine";

const VERBS = ["Led", "Built", "Reduced", "Designed", "Launched", "Automated", "Migrated", "Improved", "Mentored", "Optimized", "Delivered", "Created"];

function bullet(i: number): { text: string } {
  const metric = i % 2 === 0 ? `, cutting checkout errors by ${10 + i}% within two quarters` : " for the customer onboarding flow used by every regional sales team";
  return { text: `${VERBS[i]} the TypeScript payments service on Kubernetes alongside product and design partners${metric}` };
}

function perfectCv(): ScoreInput {
  return {
    personal: {
      full_name: "Sam Rivera",
      title: "Senior Backend Engineer",
      email: "sam@example.com",
      phone: "+1 555 010 2030",
      location: "Austin, TX",
      links: [{ label: "LinkedIn", url: "https://linkedin.com/in/sam" }],
    },
    summary:
      "Backend engineer with eight years building payment and onboarding systems for fast-growing software companies. " +
      "Known for turning slow, fragile services into reliable platforms, mentoring engineers, and shipping work that " +
      "measurably cuts errors and support load. Comfortable owning systems end to end, from design reviews through on-call.",
    experience: [0, 1, 2].map((r) => ({
      company: `Company ${r}`,
      role: "Backend Engineer",
      start_date: `20${18 + r}-01`,
      end_date: r === 2 ? "present" : `20${19 + r}-01`,
      bullets: [0, 1, 2, 3].map((b) => bullet(r * 4 + b)),
    })),
    education: [{ institution: "State University", degree: "BSc Computer Science", start_date: "2012-09", end_date: "2016-06" }],
    skillGroups: [
      { category: "Languages", items: ["TypeScript", "Go", "SQL", "Python"] },
      { category: "Platforms", items: ["Kubernetes", "AWS", "PostgreSQL", "Kafka"] },
    ],
    skills: ["TypeScript", "Go", "SQL", "Python", "Kubernetes", "AWS", "PostgreSQL", "Kafka"],
  };
}

const failing = (score: ReturnType<typeof scoreCv>) => score.checks.filter((c) => c.status !== "pass").map((c) => c.id);

describe("scoreCv", () => {
  it("scores a complete, well-written CV 100", () => {
    const score = scoreCv(perfectCv());
    expect(failing(score)).toEqual([]);
    expect(score.total).toBe(100);
    expect(score.quality).toBe(100);
    expect(score.job).toBeUndefined();
    expect(score.version).toBe(SCORE_RULES_VERSION);
    expect(score.categories.reduce((s, c) => s + c.max, 0)).toBeCloseTo(100, 5);
  });

  it("is deterministic — same input, same output", () => {
    const cv = perfectCv();
    cv.summary = "I am a hard-working team player.";
    expect(scoreCv(cv)).toEqual(scoreCv(structuredClone(cv)));
  });

  it("scores empty or missing content 0 without throwing", () => {
    expect(scoreCv({}).total).toBe(0);
    expect(scoreCv(null).total).toBe(0);
    expect(scoreCv({ experience: "nope" } as unknown as ScoreInput).total).toBe(0);
  });

  it("flags missing contact details as manual fixes with the field to focus", () => {
    const cv = perfectCv();
    cv.personal = { ...cv.personal, phone: "", links: [] };
    const score = scoreCv(cv);
    const phone = score.checks.find((c) => c.id === "contact.phone")!;
    expect(phone).toMatchObject({ status: "fail", points: 0, fix: "manual", kind: "missing", section: "personal", field: "phone" });
    expect(failing(score)).toEqual(["contact.phone", "contact.link"]);
    expect(score.total).toBe(97);
  });

  it("penalizes first person and clichés in the summary and offers a summary polish", () => {
    const cv = perfectCv();
    cv.summary = "I am a hard-working team player who is passionate about building great software for my customers every single day.";
    const voice = scoreCv(cv).checks.find((c) => c.id === "summary.voice")!;
    expect(voice.status).toBe("fail");
    expect(voice.fix).toBe("ai");
    expect(voice.polish).toEqual({ kind: "summary" });
  });

  it("checks bullets: count, action verbs, numbers, length, first person and repetition", () => {
    const cv = perfectCv();
    cv.experience![1].bullets = [{ text: "I did stuff" }, "Worked on things with the team"];
    const score = scoreCv(cv);
    const ids = failing(score);
    expect(ids).toEqual(
      expect.arrayContaining(["experience.bulletCount", "experience.actionVerbs", "experience.bulletLength", "writing.firstPerson"])
    );
    expect(score.checks.find((c) => c.id === "experience.bulletCount")).toMatchObject({ index: 1, polish: { kind: "bullets", index: 1 } });

    const repeated = perfectCv();
    repeated.experience![0].bullets = [0, 1, 2, 3].map(() => ({ text: "Led the TypeScript payments service on Kubernetes, cutting checkout errors by 12% in a year" }));
    expect(failing(scoreCv(repeated))).toContain("writing.verbVariety");
  });

  it("never offers AI for measurable results — numbers must come from the user", () => {
    const cv = perfectCv();
    for (const role of cv.experience!) role.bullets = (role.bullets ?? []).map((_, i) => ({ text: `${VERBS[i]} the onboarding flow with design and product partners across every regional team` }));
    const check = scoreCv(cv).checks.find((c) => c.id === "experience.quantified")!;
    expect(check.status).toBe("fail");
    expect(check.fix).toBe("manual");
    expect(check.polish).toBeUndefined();
  });

  it("requires one recognizable date format", () => {
    const cv = perfectCv();
    cv.experience![0].start_date = "Jan 2018";
    expect(scoreCv(cv).checks.find((c) => c.id === "writing.dates")!.status).toBe("partial");
    cv.experience![0].start_date = "sometime";
    expect(scoreCv(cv).checks.find((c) => c.id === "writing.dates")!.points).toBeLessThan(3);
  });

  it("never penalizes an absent optional section, only half-filled entries in shown ones", () => {
    const cv = perfectCv();
    expect(scoreCv(cv, null, { sections: ["projects", "awards"] }).total).toBe(100);
    cv.projects = [{ name: "" , description: "A thing" }];
    const check = scoreCv(cv, null, { sections: ["projects"] }).checks.find((c) => c.id === "sections.complete")!;
    expect(check).toMatchObject({ status: "fail", kind: "missing", section: "projects", index: 0 });
    // A section the template doesn't show isn't checked.
    expect(scoreCv(cv, null, { sections: ["awards"] }).total).toBe(100);
  });

  it("counts grouped skills and catches duplicates", () => {
    const cv = perfectCv();
    cv.skillGroups![1].items = ["typescript", "AWS", "PostgreSQL", "Kafka"];
    expect(failing(scoreCv(cv))).toContain("skills.duplicates");
  });
});

describe("scoreCv with a job", () => {
  const job: ScoreJobRequirements = {
    title: "Senior Backend Engineer",
    requiredSkills: ["TypeScript", "K8s", "GraphQL"],
    preferredSkills: ["Kafka", "Terraform"],
  };

  it("scores job match out of 100 and blends it 60/40 into the total", () => {
    const score = scoreCv(perfectCv(), job);
    const base = score.categories.filter((c) => c.key !== "job").reduce((s, c) => s + c.max, 0);
    expect(base).toBeCloseTo(100, 5);
    expect(score.categories.find((c) => c.key === "job")!.max).toBe(100);
    expect(score.quality).toBe(100);
    expect(score.job).toBeLessThan(100);
    expect(score.total).toBe(Math.round(score.quality * 0.6 + score.job! * 0.4));
  });

  it("gives partial credit for a skill only in the skills list", () => {
    const cv = perfectCv();
    cv.skillGroups![0].items!.push("GraphQL");
    const score = scoreCv(cv, { title: "Backend Engineer", requiredSkills: ["GraphQL"], preferredSkills: [] });
    expect(score.checks.find((c) => c.id === "job.required")!.status).toBe("pass");
    expect(score.checks.find((c) => c.id === "job.inContext")!.status).toBe("fail");
  });

  it("checks seniority against the roles' dates", () => {
    const now = new Date("2026-06-01");
    const senior = { title: "Backend Engineer", seniority: "senior", requiredSkills: [], preferredSkills: [] };
    const check = (cv: ScoreInput) => scoreCv(cv, senior, { now }).checks.find((c) => c.id === "job.seniority")!;
    const cv = perfectCv(); // 2018-01 → present, overlaps counted once
    expect(check(cv).status).toBe("pass");
    cv.experience = cv.experience!.slice(0, 1); // 2018-01 → 2019-01: 1 year of 5
    expect(check(cv)).toMatchObject({ status: "partial", points: 1 });
  });

  it("matches skills on whole words with aliases and reports what's missing", () => {
    const score = scoreCv(perfectCv(), job);
    expect(score.jobMatch!.required).toEqual([
      { skill: "TypeScript", found: true },
      { skill: "K8s", found: true },
      { skill: "GraphQL", found: false },
    ]);
    expect(score.jobMatch!.coverage).toBe(67);
    const required = score.checks.find((c) => c.id === "job.required")!;
    expect(required).toMatchObject({ status: "partial", fix: "manual" });
    expect(required.message).toContain("GraphQL");
    expect(score.total).toBeLessThan(100);
  });

  it("does not match a skill inside another word", () => {
    const cv = perfectCv();
    const score = scoreCv(cv, { title: "Engineer", requiredSkills: ["Go"], preferredSkills: [] });
    expect(score.jobMatch!.required[0].found).toBe(true); // listed in skills
    cv.skillGroups = [{ category: "Languages", items: ["Google Sheets"] }];
    cv.skills = ["Google Sheets"];
    expect(scoreCv(cv, { title: "Engineer", requiredSkills: ["Go"], preferredSkills: [] }).jobMatch!.required[0].found).toBe(false);
  });

  it("reaches 100 when every requirement is shown in the work", () => {
    const score = scoreCv(perfectCv(), { title: "Backend Engineer", requiredSkills: ["TypeScript", "Kubernetes"], preferredSkills: [] });
    expect(failing(score)).toEqual([]);
    expect(score.total).toBe(100);
  });

  it("offers a headline polish when the headline doesn't match the job title", () => {
    const cv = perfectCv();
    cv.personal!.title = "Software Developer";
    const check = scoreCv(cv, { title: "Platform Engineer", requiredSkills: [], preferredSkills: [] }).checks.find((c) => c.id === "job.title")!;
    expect(check).toMatchObject({ status: "fail", fix: "ai", polish: { kind: "headline" } });
  });
});

describe("engine copies", () => {
  const frontendCopy = resolve(__dirname, "../../../resume-front/src/lib/cv-score/engine.ts");

  // The editor scores live with the same file; if they drift, the number in
  // the editor and the stored one disagree. Fix: copy one over the other.
  it.skipIf(!existsSync(frontendCopy))("backend and frontend engines are identical", () => {
    const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    expect(read(frontendCopy)).toBe(read(resolve(__dirname, "../../src/services/score/engine.ts")));
  });
});
