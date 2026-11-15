import { describe, expect, it } from "vitest";
import { buildCvGenerationPrompt } from "../../src/services/ai/cv/prompts/buildCvPrompt";
import { DEFAULT_CV_TEMPLATE_ID, getAIOptionalSections } from "../../src/config/cv-templates";

const base = {
  sourceText: "Jane Doe, accountant at Dashen Bank 2019-2024.",
  templateId: DEFAULT_CV_TEMPLATE_ID,
  optionalSections: getAIOptionalSections(DEFAULT_CV_TEMPLATE_ID),
  enhancementLevel: 0.5,
};

describe("CV prompt tailoring rules", () => {
  it("sends the full tailoring rules when a job description is given", () => {
    const { system } = buildCvGenerationPrompt({ ...base, jobDescription: "Senior Accountant at CBE" });
    expect(system).toContain("ROLE COMPATIBILITY CHECK — do this before anything else");
    expect(system).toContain("KEYWORD OPTIMIZATION");
  });

  it("sends only the no-job-description rule without one", () => {
    for (const jobDescription of [undefined, "", "   "]) {
      const { system } = buildCvGenerationPrompt({ ...base, jobDescription });
      expect(system).toContain("No job description is provided:");
      expect(system).toContain("jobAnalysis must be null");
      expect(system).not.toContain("ROLE COMPATIBILITY CHECK — do this before anything else");
      expect(system).not.toContain("KEYWORD OPTIMIZATION");
    }
  });

  it("makes the no-job-description prompt substantially shorter", () => {
    const withJd = buildCvGenerationPrompt({ ...base, jobDescription: "Senior Accountant" }).system.length;
    const without = buildCvGenerationPrompt(base).system.length;
    expect(without).toBeLessThan(withJd * 0.75);
  });
});
