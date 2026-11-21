import DodoPayments from "dodopayments";
import { env } from "../../config/env";

/** Thrown when a Dodo call is attempted before DODO_PAYMENTS_API_KEY is set. */
export class DodoNotConfiguredError extends Error {
  constructor() {
    super("Dodo Payments isn't configured (DODO_PAYMENTS_API_KEY is empty)");
    this.name = "DodoNotConfiguredError";
  }
}

let client: DodoPayments | null = null;

export function isDodoConfigured(): boolean {
  return Boolean(env.DODO_PAYMENTS_API_KEY);
}

/**
 * The one Dodo client every call goes through (same convention as
 * db/client.ts's Prisma client). Created on first use, so the server boots
 * without keys; using it without a key throws DodoNotConfiguredError.
 */
export function dodo(): DodoPayments {
  if (!env.DODO_PAYMENTS_API_KEY) throw new DodoNotConfiguredError();
  client ??= new DodoPayments({
    bearerToken: env.DODO_PAYMENTS_API_KEY,
    webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
    environment: env.DODO_PAYMENTS_ENVIRONMENT,
  });
  return client;
}

/** A short, loggable message from any Dodo SDK error. */
export function dodoErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.slice(0, 300) : fallback;
}

/** The HTTP status of a Dodo API error, when there is one. */
export function dodoErrorStatus(err: unknown): number | undefined {
  return err instanceof DodoPayments.APIError ? err.status : undefined;
}
