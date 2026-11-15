import { describe, expect, it } from "vitest";
import { billedOutputTokens } from "../../src/services/ai/usage";

describe("billedOutputTokens", () => {
  it("adds Gemini thinking tokens reported outside completion_tokens", () => {
    // Vertex: 12 prompt, 9 reply, 92 thinking → total 113
    expect(billedOutputTokens({ prompt_tokens: 12, completion_tokens: 9, total_tokens: 113 })).toBe(101);
  });

  it("keeps completion_tokens when it already includes reasoning (OpenAI-style)", () => {
    expect(billedOutputTokens({ prompt_tokens: 100, completion_tokens: 250, total_tokens: 350 })).toBe(250);
  });

  it("falls back to completion_tokens when totals are missing", () => {
    expect(billedOutputTokens({ completion_tokens: 40 })).toBe(40);
    expect(billedOutputTokens({ prompt_tokens: 10, completion_tokens: 40 })).toBe(40);
  });

  it("returns null without usage", () => {
    expect(billedOutputTokens(null)).toBeNull();
    expect(billedOutputTokens(undefined)).toBeNull();
  });
});
