// What the rest of the app needs from an email service. Nothing outside
// services/email knows which vendor is behind it — adding another provider
// means implementing this interface and selecting it in ./index.ts.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe for announcements. */
  headers?: Record<string, string>;
}

export interface EmailProvider {
  /** Stable name stored on EmailLog rows ("resend", "console"). */
  readonly name: string;
  /** False when the provider only logs messages instead of delivering them. */
  readonly delivers: boolean;
  /** Resolves with the provider's message id; throws when the provider refuses. */
  send(message: EmailMessage): Promise<{ id: string | null }>;
}
