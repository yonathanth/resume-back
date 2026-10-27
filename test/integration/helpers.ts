import type { FastifyInstance } from "fastify";
import { prisma } from "../../src/db/client";
import { buildServer } from "../../src/app";
import { hashPassword } from "../../src/services/auth.service";
import { signAccessToken } from "../../src/services/token.service";
import { clearSettingsCache } from "../../src/services/settings.service";

export { prisma };

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildServer({ logger: false });
    await app.ready();
  }
  return app;
}

export async function closeApp() {
  await app?.close();
  app = null;
  await prisma.$disconnect();
}

const TABLES = [
  "UserNotification",
  "Notification",
  "PushSubscription",
  "EmailLog",
  "AiUsageEvent",
  "AdminAuditLog",
  "PlatformSetting",
  "Entitlement",
  "PasswordResetToken",
  "EmailVerificationToken",
  "RefreshToken",
  "RateLimitHit",
  "WebhookEvent",
  "Payment",
  "CVImport",
  "ProfileChange",
  "CVDocument",
  "CareerProfile",
  "User",
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  clearSettingsCache();
}

// Hashing once and reusing keeps the suite fast (bcrypt cost 12).
let cachedHash: { password: string; hash: string } | null = null;
export const PASSWORD = "correct-horse-battery-1";

export async function createUser(opts: { email?: string; role?: "USER" | "ADMIN"; verified?: boolean; status?: string } = {}) {
  if (!cachedHash) cachedHash = { password: PASSWORD, hash: await hashPassword(PASSWORD) };
  return prisma.user.create({
    data: {
      email: opts.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`,
      passwordHash: cachedHash.hash,
      role: opts.role ?? "USER",
      status: opts.status ?? "ACTIVE",
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      onboardingCompletedAt: new Date(),
    },
  });
}

export function bearer(userId: string) {
  return { authorization: `Bearer ${signAccessToken(userId)}` };
}

/** Pulls the refresh cookie value out of a login/verify response. */
export function refreshCookieFrom(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === "refreshToken")?.value ?? null;
}
