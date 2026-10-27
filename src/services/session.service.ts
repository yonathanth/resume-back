import crypto from "node:crypto";
import { prisma } from "../db/client";

// A session lasts 30 days from its last refresh — every /auth/refresh rotates
// the token and restarts the clock, so an active user is never signed out and
// an idle one stays signed in for a full 30 days.
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Two tabs (or a retried request) can refresh with the same cookie at nearly
// the same moment; the loser presents a token that was rotated a moment ago.
// Inside this window that's treated as a benign race, not token theft.
const ROTATION_GRACE_MS = 30 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: newExpiry() },
  });
  // Opportunistic cleanup of this user's expired rows. Revoked-but-unexpired
  // rows are kept on purpose: they're what lets rotateSession spot a replayed
  // stolen token.
  await prisma.refreshToken.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
  return token;
}

export type RotateResult =
  // `token` is null for a grace-window race: the browser already holds the
  // newer cookie from the winning request, so don't overwrite it.
  | { ok: true; userId: string; token: string | null }
  | { ok: false };

export async function rotateSession(token: string): Promise<RotateResult> {
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!existing || existing.expiresAt <= new Date()) {
    return { ok: false };
  }

  if (!existing.revokedAt) return rotateRow(existing);

  // Ended by logout, a password change or "sign out everywhere": never valid again.
  if (!existing.replacedById) return { ok: false };

  if (Date.now() - existing.revokedAt.getTime() < ROTATION_GRACE_MS) {
    return { ok: true, userId: existing.userId, token: null };
  }

  // The browser never stored this token's replacement: the refresh response
  // was lost (tab closed or navigated mid-request, dropped connection). The
  // replacement has never been used, so carry the session on from it rather
  // than signing the user out.
  const successor = await prisma.refreshToken.findUnique({ where: { id: existing.replacedById } });
  if (successor && !successor.revokedAt && successor.expiresAt > new Date()) {
    return rotateRow(successor);
  }

  // The replacement was itself used, so two parties hold this session: assume
  // the token leaked and end every session this user has.
  await revokeAllSessions(existing.userId);
  return { ok: false };
}

async function rotateRow(existing: { id: string; userId: string }): Promise<RotateResult> {
  const nextToken = crypto.randomBytes(32).toString("base64url");
  const rotated = await prisma.$transaction(async (tx) => {
    // Conditional update so two concurrent rotations of the same row can't both win.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    const next = await tx.refreshToken.create({
      data: { userId: existing.userId, tokenHash: hashToken(nextToken), expiresAt: newExpiry() },
    });
    await tx.refreshToken.update({ where: { id: existing.id }, data: { replacedById: next.id } });
    return true;
  });

  if (!rotated) {
    // Lost the race to a concurrent refresh — same as the grace-window case.
    return { ok: true, userId: existing.userId, token: null };
  }

  return { ok: true, userId: existing.userId, token: nextToken };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
