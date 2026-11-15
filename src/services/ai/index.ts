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
    case "vertex":
      // Gemini on Vertex AI: billed to the project's Cloud billing account (so
      // Cloud credits apply), unlike the Gemini API's AI Studio billing. Vertex
      // takes an API key in x-goog-api-key, not as a Bearer token, so the
      // SDK's Authorization header is dropped.
      return new OpenAICompatibleProvider({
        apiKey: env.VERTEX_API_KEY!,
        baseURL: `https://aiplatform.googleapis.com/v1/projects/${env.VERTEX_PROJECT}/locations/${env.VERTEX_LOCATION}/endpoints/openapi`,
        model: env.VERTEX_MODEL,
        reasoningEffort: env.GEMINI_REASONING_EFFORT,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        defaultHeaders: { "x-goog-api-key": env.VERTEX_API_KEY!, Authorization: null },
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
