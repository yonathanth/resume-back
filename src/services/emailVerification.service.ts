import crypto from "node:crypto";
import type { User } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendEmailOrThrow } from "./email/send";
import { verificationCodeEmail } from "./email/templates";
import { createRateLimiter, type RateResult } from "../utils/rate-limit";

// Email sign-up is confirmed with a 6-digit code typed back into the app, so
// the person stays on the page they signed up from (the try-flow pop-up
// carries on in place) and can read the code on any device.

/** How long a code works. Short: it's typed in right away. */
export const CODE_TTL_MINUTES = 15;
/** Wrong codes allowed per code before a new one must be sent. */
export const MAX_CODE_ATTEMPTS = 5;

// Keyed with a server secret and the user's id: a leaked table can't be
// brute-forced offline (a million codes is nothing to a plain hash), and two
// users holding the same code never collide on the unique column.
function hashCode(userId: string, code: string): string {
  return crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(`email-code:${userId}:${code}`).digest("hex");
}

// Links from before codes (sha256 of a random token) — still honoured until they expire.
function hashLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Digits only, so "123 456" or "123-456" pasted from an email still matches. */
export function normalizeCode(input: string): string {
  return input.replace(/\D/g, "");
}

// Issues a fresh code for the user. Any earlier code stops working, so only
// the most recent email can confirm the address.
export async function createVerificationCode(userId: string): Promise<string> {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: hashCode(userId, code),
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      },
    }),
  ]);
  return code;
}

export type CodeCheck =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid"; attemptsLeft: number }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "too_many_attempts" };

// Checks a code for an email and, when it's right, marks the email verified
// and spends the code. A wrong code counts against the code's attempts; at
// the limit (or once expired) it's gone and a new one must be sent. Unknown
// or already-verified emails look like a wrong code, so this reveals nothing.
export async function verifyEmailCode(email: string, input: string): Promise<CodeCheck> {
  const user = await prisma.user.findUnique({ where: { email } });
  const record = user && !user.emailVerifiedAt
    ? await prisma.emailVerificationToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } })
    : null;
  if (!user || !record) return { ok: false, reason: "invalid", attemptsLeft: MAX_CODE_ATTEMPTS };

  if (record.expiresAt <= new Date()) {
    await prisma.emailVerificationToken.deleteMany({ where: { id: record.id } });
    return { ok: false, reason: "expired" };
  }
  if (record.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const code = normalizeCode(input);
  const expected = Buffer.from(record.tokenHash);
  const actual = Buffer.from(hashCode(user.id, code));
  const matches = code.length === 6 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    // Counted atomically, so parallel guesses can't slip past the limit.
    const { count } = await prisma.emailVerificationToken.updateMany({
      where: { id: record.id, attempts: { lt: MAX_CODE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0) return { ok: false, reason: "too_many_attempts" };
    const attemptsLeft = MAX_CODE_ATTEMPTS - (record.attempts + 1);
    return attemptsLeft > 0 ? { ok: false, reason: "invalid", attemptsLeft } : { ok: false, reason: "too_many_attempts" };
  }

  // Spend it; the conditional delete keeps it single-use under a race.
  const { count } = await prisma.emailVerificationToken.deleteMany({
    where: { id: record.id, expiresAt: { gt: new Date() }, attempts: { lt: MAX_CODE_ATTEMPTS } },
  });
  if (count !== 1) return { ok: false, reason: "expired" };

  const verified = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return { ok: true, user: verified };
}

// Spends a confirmation link from an email sent before codes, and marks its
// user's email verified. Returns null for an unknown, used or expired token.
export async function consumeVerificationToken(token: string): Promise<User | null> {
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashLinkToken(token) } });
  if (!record) return null;

  const { count } = await prisma.emailVerificationToken.deleteMany({
    where: { id: record.id, expiresAt: { gt: new Date() } },
  });
  if (count !== 1) {
    // Expired: clean it up so it can't linger.
    await prisma.emailVerificationToken.deleteMany({ where: { id: record.id } });
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) return null;
  if (user.emailVerifiedAt) return user;
  return prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
}

// Sends the code through the configured provider (see services/email).
// Without email credentials outside production the console provider logs the
// email instead, so sign-up still works locally; in production a missing or
// failing provider throws.
export async function sendVerificationEmail(email: string, code: string, userId?: string): Promise<void> {
  await sendEmailOrThrow({ to: email, userId, kind: "verification", ...verificationCodeEmail(code, CODE_TTL_MINUTES) });
}

/** A new code for the user, emailed. */
export async function issueVerificationCode(user: Pick<User, "id" | "email">): Promise<void> {
  await sendVerificationEmail(user.email, await createVerificationCode(user.id), user.id);
}

// Caps on resend requests, per email address and per IP: at most one a minute
// and five an hour. Counted in the database, so every server instance shares them.
const RESEND_WINDOWS = [
  { ms: 60 * 1000, max: 1 },
  { ms: 60 * 60 * 1000, max: 5 },
];
const resendLimiter = createRateLimiter("resend", RESEND_WINDOWS);

/** Records a resend for every key, or returns how long to wait if any key is capped. */
export function takeResendSlot(keys: string[]): Promise<RateResult> {
  return resendLimiter.take(keys);
}
