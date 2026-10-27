import crypto from "node:crypto";
import type { User } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendEmail, sendEmailOrThrow } from "./email/send";
import { emailChangeCodeEmail, emailChangedNoticeEmail } from "./email/templates";
import { deleteUserAccount } from "./accountDeletion.service";
import { normalizeCode } from "./emailVerification.service";

// Changing a signed-in user's email. The new address only takes over once
// the 6-digit code sent to it is typed back, so nobody can move an account
// to an address they don't control (or lock themselves out with a typo). The
// old address is told afterwards, in case it wasn't them.

export const EMAIL_CHANGE_TTL_MINUTES = 15;
export const MAX_EMAIL_CHANGE_ATTEMPTS = 5;

// Keyed with the user's id and the new address: a code only ever confirms
// the address it was sent to, for the user who asked.
function hashCode(userId: string, newEmail: string, code: string): string {
  return crypto
    .createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(`email-change:${userId}:${newEmail.toLowerCase()}:${code}`)
    .digest("hex");
}

/** The address held by another account that has proven it (unconfirmed sign-ups don't count). */
async function takenByOtherAccount(userId: string, email: string): Promise<boolean> {
  const other = await prisma.user.findUnique({ where: { email } });
  return Boolean(other && other.id !== userId && (other.emailVerifiedAt || other.googleId));
}

export class EmailChangeError extends Error {
  constructor(
    public code: "SAME_EMAIL" | "EMAIL_TAKEN",
    message: string
  ) {
    super(message);
  }
}

/**
 * Starts (or restarts) a change to `newEmail`: checks it's free and emails
 * it a code. Any earlier pending change for the user is replaced.
 */
export async function startEmailChange(user: Pick<User, "id" | "email">, newEmail: string): Promise<void> {
  if (newEmail.toLowerCase() === user.email.toLowerCase()) {
    throw new EmailChangeError("SAME_EMAIL", "That's already your email.");
  }
  if (await takenByOtherAccount(user.id, newEmail)) {
    throw new EmailChangeError("EMAIL_TAKEN", "An account with this email already exists");
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const data = {
    newEmail,
    codeHash: hashCode(user.id, newEmail, code),
    attempts: 0,
    expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MINUTES * 60 * 1000),
  };
  await prisma.emailChangeRequest.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...data },
    update: { ...data, createdAt: new Date() },
  });
  await sendEmailOrThrow({
    to: newEmail,
    userId: user.id,
    kind: "email_change",
    ...emailChangeCodeEmail(code, EMAIL_CHANGE_TTL_MINUTES),
  });
}

/** The address a pending, unexpired change is waiting on, if any. */
export async function pendingEmailChange(userId: string): Promise<string | null> {
  const request = await prisma.emailChangeRequest.findUnique({ where: { userId } });
  return request && request.expiresAt > new Date() && request.attempts < MAX_EMAIL_CHANGE_ATTEMPTS ? request.newEmail : null;
}

export type EmailChangeResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid"; attemptsLeft: number }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "too_many_attempts" }
  | { ok: false; reason: "no_request" }
  | { ok: false; reason: "taken" };

/**
 * Checks the code for the user's pending change and, when it's right, moves
 * the account to the new address (verified — the code proves they read it).
 * Same rules as sign-up codes: expiry, a few tries, single use.
 */
export async function confirmEmailChange(userId: string, input: string): Promise<EmailChangeResult> {
  const request = await prisma.emailChangeRequest.findUnique({ where: { userId } });
  if (!request) return { ok: false, reason: "no_request" };

  if (request.expiresAt <= new Date()) {
    await prisma.emailChangeRequest.deleteMany({ where: { id: request.id } });
    return { ok: false, reason: "expired" };
  }
  if (request.attempts >= MAX_EMAIL_CHANGE_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const code = normalizeCode(input);
  const expected = Buffer.from(request.codeHash);
  const actual = Buffer.from(hashCode(userId, request.newEmail, code));
  const matches = code.length === 6 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    // Counted atomically, so parallel guesses can't slip past the limit.
    const { count } = await prisma.emailChangeRequest.updateMany({
      where: { id: request.id, attempts: { lt: MAX_EMAIL_CHANGE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0) return { ok: false, reason: "too_many_attempts" };
    const attemptsLeft = MAX_EMAIL_CHANGE_ATTEMPTS - (request.attempts + 1);
    return attemptsLeft > 0 ? { ok: false, reason: "invalid", attemptsLeft } : { ok: false, reason: "too_many_attempts" };
  }

  // Spend it; the conditional delete keeps it single-use under a race.
  const { count } = await prisma.emailChangeRequest.deleteMany({
    where: { id: request.id, expiresAt: { gt: new Date() }, attempts: { lt: MAX_EMAIL_CHANGE_ATTEMPTS } },
  });
  if (count !== 1) return { ok: false, reason: "expired" };

  // Someone may have claimed the address since the code was sent.
  if (await takenByOtherAccount(userId, request.newEmail)) return { ok: false, reason: "taken" };

  // An unconfirmed sign-up holding the address never proved it owned it (and
  // could never sign in, so it has nothing in it): it gives way.
  const stale = await prisma.user.findUnique({ where: { email: request.newEmail } });
  if (stale && stale.id !== userId) await deleteUserAccount(stale.id);

  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const user = await prisma.user.update({
    where: { id: userId },
    data: { email: request.newEmail, emailVerifiedAt: before.emailVerifiedAt ?? new Date() },
  });

  // Tell the old address, in case it wasn't them. Never blocks the change.
  void sendEmail({ to: before.email, userId, kind: "email_change", ...emailChangedNoticeEmail(user.email) });
  return { ok: true, user };
}

/** Drops the user's pending change, if any (they changed their mind). */
export async function cancelEmailChange(userId: string): Promise<void> {
  await prisma.emailChangeRequest.deleteMany({ where: { userId } });
}
