import type { AIGenerateInput } from "../../provider.interface";
import { buildSystemPrompt } from "./system.prompt";
import { buildUserMessage } from "./user.prompt";

export interface CvPromptMessages {
  system: string;
  user: string;
}

/**
 * Single entrypoint any AI provider uses to get CV generation prompt text.
 * Providers must call this instead of building prompt strings themselves —
 * it's what keeps CV business rules (src/services/ai/cv/rules) separate from
 * provider mechanics (e.g. openai-compatible.provider.ts).
 */
export function buildCvGenerationPrompt(input: AIGenerateInput): CvPromptMessages {
  return {
    system: buildSystemPrompt({ optionalSections: input.optionalSections, enhancementLevel: input.enhancementLevel }),
    user: buildUserMessage(input),
  };
}
