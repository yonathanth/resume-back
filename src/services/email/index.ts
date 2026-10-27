import { Resend } from "resend";
import { env } from "../../config/env";
import type { EmailProvider, EmailMessage } from "./provider";

export type { EmailMessage, EmailProvider } from "./provider";

class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  readonly delivers = true;
  private client: Resend;

  constructor(apiKey: string, private from: string) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage) {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    });
    if (error) throw new Error(`Resend: ${error.message}`);
    return { id: data?.id ?? null };
  }
}

// Development fallback: prints the message (links included) to the server
// log instead of sending it, so sign-up and password reset work locally.
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  readonly delivers = false;

  async send(message: EmailMessage) {
    console.info(`[email] (console provider — not delivered) to ${message.to}: ${message.subject}\n${message.text}`);
    return { id: null };
  }
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("EMAIL_NOT_CONFIGURED: set RESEND_API_KEY and EMAIL_FROM (or EMAIL_PROVIDER=console)");
    this.name = "EmailNotConfiguredError";
  }
}

let cached: EmailProvider | null | undefined;

/** The configured provider, or null when nothing can send (production without credentials). */
export function getEmailProvider(): EmailProvider | null {
  if (cached !== undefined) return cached;
  const resendReady = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const choice = env.EMAIL_PROVIDER ?? (resendReady ? "resend" : env.NODE_ENV === "production" ? null : "console");

  if (choice === "resend") {
    cached = resendReady ? new ResendEmailProvider(env.RESEND_API_KEY!, env.EMAIL_FROM!) : null;
  } else if (choice === "console") {
    cached = new ConsoleEmailProvider();
  } else {
    cached = null;
  }
  return cached;
}

/** Non-secret configuration summary for the admin health view. */
export function emailConfigStatus() {
  const provider = getEmailProvider();
  const fromDomain = env.EMAIL_FROM?.match(/@([^>\s]+)/)?.[1] ?? null;
  return {
    provider: provider?.name ?? null,
    delivers: provider?.delivers ?? false,
    fromDomain,
    configured: Boolean(provider?.delivers),
  };
}
