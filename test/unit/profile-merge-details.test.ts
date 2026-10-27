import { describe, expect, it } from "vitest";
import { cvContentToProfileContent, matchKey, mergeProfileContent } from "../../src/services/profileContent.service";
import { emptyProfileContent } from "../../src/schemas/profile-content.schema";

const asProfile = (cv: Parameters<typeof cvContentToProfileContent>[0]) => cvContentToProfileContent(cv, { source: "cv", includeProse: true });

describe("merge details (what the update card shows)", () => {
  const base = asProfile({
    experience: [{ company: "Acme", role: "Backend Engineer", bullets: [{ text: "Built the billing API" }] }],
    skills: ["Python"],
    education: [{ institution: "AAU", degree: "BSc Computer Science" }],
  });
  const incoming = asProfile({
    summary: "Engineer who ships.",
    experience: [
      {
        company: "Acme",
        role: "Backend Engineer",
        start_date: "2021-01",
        bullets: [{ text: "Built the billing API" }, { text: "Cut p95 latency by 40% with caching" }],
      },
      { company: "Globex", role: "Intern", bullets: [{ text: "Wrote tests" }] },
    ],
    skills: ["Python", "Go"],
    education: [{ institution: "AAU", degree: "BSc Computer Science", end_date: "2020-06" }],
  });

  it("lists new items, filled fields and new bullets", () => {
    const { details } = mergeProfileContent(base, incoming);
    expect(details).toContainEqual({ section: "summary", change: "added", label: "Summary", text: "Engineer who ships." });
    expect(details).toContainEqual({
      section: "experience",
      change: "updated",
      label: "Backend Engineer",
      sublabel: "Acme",
      filled: ["start date"],
      newBullets: ["Cut p95 latency by 40% with caching"],
    });
    expect(details).toContainEqual({ section: "experience", change: "added", label: "Intern", sublabel: "Globex", newBullets: ["Wrote tests"] });
    expect(details).toContainEqual({ section: "skills", change: "added", label: "Go" });
    expect(details.some((d) => d.section === "skills" && d.label === "Python")).toBe(false);
  });

  it("says when it leaves an edited item alone, or skips one the user deleted", () => {
    const edited = structuredClone(base);
    edited.education[0].meta = { ...edited.education[0].meta, locked: true };
    edited.dismissedKeys = [`experience:${matchKey("experience", { company: "Globex", role: "Intern" })}`];
    const { details } = mergeProfileContent(edited, incoming);
    expect(details).toContainEqual({ section: "education", change: "kept_edited", label: "BSc Computer Science", sublabel: "AAU" });
    expect(details).toContainEqual({ section: "experience", change: "kept_removed", label: "Intern", sublabel: "Globex" });
    expect(details.some((d) => d.section === "education" && d.change === "updated")).toBe(false);
  });

  it("describes a brand-new profile item by item", () => {
    const { details } = mergeProfileContent(emptyProfileContent(), incoming);
    expect(details.filter((d) => d.change === "added").map((d) => d.label)).toEqual(
      expect.arrayContaining(["Summary", "Backend Engineer", "Intern", "Python", "Go", "BSc Computer Science"])
    );
  });
});
