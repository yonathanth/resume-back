import { env } from "../../config/env";
import type { AIProvider } from "./provider.interface";
import { OpenAICompatibleProvider } from "./openai-compatible.provider";

// Every provider here speaks the OpenAI chat API, so they share one
// implementation and differ only in endpoint, key and model. Pick one with
// AI_PROVIDER in .env.
export function getAIProvider(): AIProvider {
  switch (env.AI_PROVIDER) {
    case "groq":
      return new OpenAICompatibleProvider({
        apiKey: env.GROQ_API_KEY!,
        baseURL: "https://api.groq.com/openai/v1",
        model: env.GROQ_MODEL,
        // Only gpt-oss models accept reasoning_effort; other Groq models reject it.
        reasoningEffort: env.GROQ_MODEL.startsWith("openai/gpt-oss") ? env.GROQ_REASONING_EFFORT : undefined,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      });
    case "gemini":
      return new OpenAICompatibleProvider({
        apiKey: env.GEMINI_API_KEY!,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: env.GEMINI_MODEL,
        reasoningEffort: env.GEMINI_REASONING_EFFORT,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      });
    case "mistral":
      return new OpenAICompatibleProvider({
        apiKey: env.MISTRAL_API_KEY!,
        baseURL: "https://api.mistral.ai/v1",
        model: env.MISTRAL_MODEL,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      });
    default:
      throw new Error(`AI provider "${env.AI_PROVIDER}" is not implemented`);
  }
}

export type { AIProvider, AIGenerateInput, CvUserIdentity } from "./provider.interface";
