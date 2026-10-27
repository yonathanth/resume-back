import { AsyncLocalStorage } from "node:async_hooks";
import { APIConnectionTimeoutError, APIError } from "openai";
import { prisma } from "../../db/client";
import { env } from "../../config/env";

// Lightweight, privacy-conscious AI usage logging: one AiUsageEvent per call
// to the provider (with the token counts the provider reports) plus the
// app-side refusals (quota, rate limit, paused). Never stores prompts, CV
// text, API keys or tokens. Logging failures are swallowed — they must never
// break a user's request.

export type AiOperation = "cv_generation" | "polish_summary" | "role_match" | "jd_analysis" | "cv_review" | "cv_polish";

export type AiUsageStatus =
  | "success"
  | "provider_rate_limited"
  | "timeout"
  | "provider_error"
  | "invalid_output"
  | "limit_reached"
  | "app_rate_limited"
  | "paused";

interface AiUsageContext {
  userId?: string;
  flowType?: string;
}

const context = new AsyncLocalStorage<AiUsageContext>();

/** Runs `fn` with the user (and flow) every AI call inside it is attributed to. */
export function withAiUsageContext<T>(ctx: AiUsageContext, fn: () => Promise<T>): Promise<T> {
  return context.run(ctx, fn);
}

export function currentProviderName(): string {
  return env.AI_PROVIDER;
}

export function currentModelName(): string {
  return { groq: env.GROQ_MODEL, gemini: env.GEMINI_MODEL, mistral: env.MISTRAL_MODEL }[env.AI_PROVIDER];
}

interface RecordInput {
  operation: AiOperation;
  status: AiUsageStatus;
  provider?: string;
  model?: string;
  userId?: string;
  flowType?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  latencyMs?: number;
}

export async function recordAiUsage(input: RecordInput): Promise<void> {
  const ctx = context.getStore();
  try {
    await prisma.aiUsageEvent.create({
      data: {
        userId: input.userId ?? ctx?.userId ?? null,
        flowType: input.flowType ?? ctx?.flowType ?? null,
        operation: input.operation,
        provider: input.provider ?? currentProviderName(),
        model: input.model ?? currentModelName(),
        status: input.status,
        errorCode: input.errorCode ?? null,
        // Provider error messages can echo request details — keep them short.
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 300) : null,
        promptTokens: input.usage?.prompt_tokens ?? null,
        completionTokens: input.usage?.completion_tokens ?? null,
        totalTokens: input.usage?.total_tokens ?? null,
        latencyMs: input.latencyMs ?? null,
      },
    });
  } catch (err) {
    console.warn("[ai-usage] failed to record usage event", err instanceof Error ? err.message : err);
  }
}

/** Maps a provider SDK error to a usage status and a short code. */
export function classifyAiError(err: unknown): { status: AiUsageStatus; errorCode: string; message: string } {
  if (err instanceof APIConnectionTimeoutError) {
    return { status: "timeout", errorCode: "TIMEOUT", message: "Request to the AI provider timed out" };
  }
  if (err instanceof APIError) {
    const code = `HTTP_${err.status ?? "ERR"}`;
    if (err.status === 429) return { status: "provider_rate_limited", errorCode: code, message: err.message };
    return { status: "provider_error", errorCode: code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid JSON|empty summary/i.test(message)) {
    return { status: "invalid_output", errorCode: "INVALID_OUTPUT", message };
  }
  return { status: "provider_error", errorCode: "UNKNOWN", message };
}

/** Times one provider call and records its outcome (rethrowing errors). */
export async function trackAiCall<T extends { usage?: RecordInput["usage"] }>(
  operation: AiOperation,
  model: string,
  call: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const result = await call();
    void recordAiUsage({ operation, model, status: "success", usage: result.usage, latencyMs: Date.now() - started });
    return result;
  } catch (err) {
    const { status, errorCode, message } = classifyAiError(err);
    void recordAiUsage({ operation, model, status, errorCode, errorMessage: message, latencyMs: Date.now() - started });
    throw err;
  }
}
