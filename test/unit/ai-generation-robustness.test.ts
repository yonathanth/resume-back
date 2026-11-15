import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateAnalyzeResult, validateGeneratedCv } from "../../src/services/ai/cv/generation/validateGeneratedCv";
import { DEFAULT_CV_TEMPLATE_ID } from "../../src/config/cv-templates";

const generateCV = vi.fn();
vi.mock("../../src/services/ai", () => ({ getAIProvider: () => ({ generateCV }) }));

const { generateCVContent, AIInvalidOutputError, describeOutputShape } = await import("../../src/services/aiGeneration.service");
const { AIUnparseableOutputError } = await import("../../src/services/ai/openai-compatible.provider");

const context = { templateId: DEFAULT_CV_TEMPLATE_ID };
const noExperience = {
  candidateData: { personal: { full_name: "Hana T", email: "hana@gmail.com", title: "Marketing graduate" }, education: [{ institution: "AAU", degree: "BA" }] },
  questions: [],
  jobAnalysis: null,
};
const goodCv = {
  candidateData: {
    personal: { full_name: "Hana T", email: "hana@gmail.com", title: "Marketer" },
    experience: [{ company: "Ride", role: "Marketing Assistant", bullets: [{ text: "Launched a referral program" }] }],
    skills: ["Canva"],
  },
  questions: [],
  jobAnalysis: null,
};

describe("AI CVs without experience or skills", () => {
  it("are accepted rather than failing, and the user is asked for both", () => {
    const result = validateAnalyzeResult(noExperience, context);
    expect(result.success).toBe(true);
    const ids = result.success ? result.data.questions.map((q) => q.id) : [];
    expect(ids).toContain("section_experience");
    expect(ids).toContain("section_skills");
  });

  it("pass the save check (exporting still requires them, at finalize)", () => {
    expect(validateGeneratedCv(noExperience.candidateData, context).success).toBe(true);
  });

  it("don't ask for sections the CV already has", () => {
    const result = validateAnalyzeResult(goodCv, context);
    const ids = result.success ? result.data.questions.map((q) => q.id) : [];
    expect(ids).not.toContain("section_experience");
    expect(ids).not.toContain("section_skills");
  });
});

describe("generateCVContent with unreadable replies", () => {
  beforeEach(() => generateCV.mockReset());

  it("retries a cut-off reply once with a bigger output cap", async () => {
    generateCV.mockRejectedValueOnce(new AIUnparseableOutputError("length", 15000)).mockResolvedValueOnce(goodCv);
    const result = await generateCVContent({ sourceText: "Hana, marketing at Ride", templateId: DEFAULT_CV_TEMPLATE_ID });
    expect("candidateData" in result && result.candidateData.experience?.length).toBe(1);
    expect(generateCV).toHaveBeenCalledTimes(2);
    const retry = generateCV.mock.calls[1][0];
    expect(retry.maxOutputTokens).toBeGreaterThan(4096);
    expect(retry.repairNotes).toMatch(/cut off/);
  });

  it("retries a non-JSON reply once at the normal cap", async () => {
    generateCV.mockRejectedValueOnce(new AIUnparseableOutputError("stop", 40)).mockResolvedValueOnce(goodCv);
    await generateCVContent({ sourceText: "Hana", templateId: DEFAULT_CV_TEMPLATE_ID });
    expect(generateCV.mock.calls[1][0].maxOutputTokens).toBeUndefined();
    expect(generateCV.mock.calls[1][0].repairNotes).toMatch(/not valid JSON/);
  });

  it("gives up with a descriptive error when the repair is unreadable too", async () => {
    generateCV
      .mockRejectedValueOnce(new AIUnparseableOutputError("length", 15000))
      .mockRejectedValueOnce(new AIUnparseableOutputError("length", 30000));
    const run = generateCVContent({ sourceText: "Hana", templateId: DEFAULT_CV_TEMPLATE_ID });
    await expect(run).rejects.toBeInstanceOf(AIInvalidOutputError);
    await expect(run).rejects.toThrow(/finish_reason=length, 30000 chars/);
    expect(generateCV).toHaveBeenCalledTimes(2);
  });
});

describe("describeOutputShape", () => {
  it("describes structure without any of the text", () => {
    const shape = describeOutputShape({ candidateData: { personal: { full_name: "Secret Name", email: "" }, experience: [], skills: ["a", "b"] }, questions: [{}] });
    expect(shape).toBe("candidateData{personal[full_name] experience:0 skills:2} questions:1");
    expect(shape).not.toContain("Secret");
  });
});
