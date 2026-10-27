import { describe, expect, it } from "vitest";
import { sanitizeAnalyzeResult } from "../../src/services/ai/cv/generation/validateGeneratedCv";

const candidateData = {
  personal: { full_name: "Abel Tesfaye", email: "abel@example.com", title: "Software Engineer" },
  experience: [
    { company: "ShalOps Digital Solutions PLC", role: "Backend Intern", start_date: "2024-06", end_date: "2024-09", bullets: [{ text: "Built APIs" }] },
  ],
  education: [{ institution: "Addis Ababa University", degree: "BSc Software Engineering", start_date: "2021", end_date: "2026" }],
  skills: ["Node.js"],
};

const q = (id: string, question: string) => ({ id, question, reason: "r", type: "text", required: false });

function questionsFor(questions: unknown[], data: unknown = candidateData) {
  const result = sanitizeAnalyzeResult({ candidateData: data, questions, jobAnalysis: null }, { templateId: "professional" }) as {
    questions: { id: string }[];
  };
  return result.questions.map((x) => x.id);
}

describe("clarification questions", () => {
  it("drops questions asking to confirm facts the CV already states", () => {
    const ids = questionsFor([
      q("institution", "Could you confirm the full name of the institution where you studied (e.g., Addis Ababa University)?"),
      q("degree", "Could you confirm the exact degree you are pursuing (e.g., Bachelor of Science in Software Engineering)?"),
      q("shalops_dates", "Could you confirm the exact start and end dates for your role at ShalOps Digital Solutions PLC?"),
    ]);
    expect(ids).not.toEqual(expect.arrayContaining(["institution", "degree", "shalops_dates"]));
  });

  it("drops non-'confirm' questions about facts an entry already has", () => {
    const ids = questionsFor([
      q("shalops_when", "When did you start and finish at ShalOps Digital Solutions PLC?"),
      q("school", "Which university did you attend, and what degree are you studying?"),
    ]);
    expect(ids).not.toContain("shalops_when");
    expect(ids).not.toContain("school");
  });

  it("keeps questions that deepen an entry or ask for something missing", () => {
    const ids = questionsFor([
      q("shalops_scale", "Roughly how many users relied on the APIs you built at ShalOps Digital Solutions PLC?"),
      q("next_role", "Which role are you aiming for next?"),
    ]);
    expect(ids).toEqual(expect.arrayContaining(["shalops_scale", "next_role"]));
  });

  it("still asks for dates that really are missing", () => {
    const data = { ...candidateData, experience: [{ ...candidateData.experience[0], start_date: undefined, end_date: undefined }] };
    const ids = questionsFor([q("shalops_when", "When did you start and finish at ShalOps Digital Solutions PLC?")], data);
    expect(ids).toContain("shalops_when");
  });
});
