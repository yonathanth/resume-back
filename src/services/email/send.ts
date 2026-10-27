import { prisma } from "../../db/client";
import { EmailNotConfiguredError, getEmailProvider } from "./index";
import type { EmailMessage } from "./provider";

export type EmailKind =
  | "verification"
  | "email_change"
  | "password_reset"
  | "announcement"
  | "subscription"
  | "lifecycle"
  | "test";

export interface SendEmailInput extends EmailMessage {
  kind: EmailKind;
  userId?: string | null;
  notificationId?: string | null;
}

export type SendEmailResult = { status: "sent" | "skipped"; id: string | null } | { status: "failed"; error: string };

async function log(input: SendEmailInput, provider: string, status: string, extra: { error?: string; id?: string | null }) {
  try {
    await prisma.emailLog.create({
      data: {
        userId: input.userId ?? null,
        toEmail: input.to,
        kind: input.kind,
        subject: input.subject.slice(0, 300),
        provider,
        status,
        error: extra.error?.slice(0, 500) ?? null,
        providerMessageId: extra.id ?? null,
        notificationId: input.notificationId ?? null,
      },
    });
  } catch (err) {
    console.warn("[email] failed to write email log", err instanceof Error ? err.message : err);
  }
}

/**
 * Sends one email through the configured provider and records the outcome
 * in EmailLog. Never throws — callers that must fail loudly (e.g. sign-up in
 * production without email) use sendEmailOrThrow.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const provider = getEmailProvider();
  if (!provider) {
    const error = new EmailNotConfiguredError().message;
    await log(input, "none", "failed", { error });
    return { status: "failed", error };
  }
  try {
    const { id } = await provider.send(input);
    const status = provider.delivers ? "sent" : "skipped";
    await log(input, provider.name, status, {
      id,
      error: provider.delivers ? undefined : "Console provider: logged to the server output, not delivered",
    });
    return { status, id };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown email error";
    await log(input, provider.name, "failed", { error });
    return { status: "failed", error };
  }
}

export async function sendEmailOrThrow(input: SendEmailInput): Promise<void> {
  const result = await sendEmail(input);
  if (result.status === "failed") throw new Error(result.error);
}
