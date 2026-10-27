import crypto from "node:crypto";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { hashPassword } from "./auth.service";
import { revokeAllSessions } from "./session.service";
import { sendEmail, type SendEmailResult } from "./email/send";
import { passwordResetEmail } from "./email/templates";

// Password reset by email link. Nobody — admins included — ever sees or sets
// a user's password: an admin can only send this link. A link works once,
// for an hour; a new link replaces earlier ones. Using it signs out every
// session.

export const RESET_TOKEN_TTL_MINUTES = 60;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createPasswordResetToken(userId: string, requestedById?: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
        requestedById: requestedById ?? null,
      },
    }),
  ]);
  return token;
}

export async function sendPasswordResetEmail(
  user: { id: string; email: string },
  requestedById?: string
): Promise<SendEmailResult> {
  const token = await createPasswordResetToken(user.id, requestedById);
  const link = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return sendEmail({ to: user.email, userId: user.id, kind: "password_reset", ...passwordResetEmail(link, RESET_TOKEN_TTL_MINUTES) });
}

/**
 * Spends a reset token and sets the new password. Returns false for an
 * unknown, used or expired token. The conditional delete makes the token
 * single-use even when two requests race with it. The link proves the user
 * controls the address, so an unconfirmed email counts as confirmed after it.
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<boolean> {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return false;

  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { id: record.id, expiresAt: { gt: new Date() } },
  });
  if (count !== 1) {
    await prisma.passwordResetToken.deleteMany({ where: { id: record.id } });
    return false;
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) return false;

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
  });
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
  await revokeAllSessions(user.id);
  return true;
}
