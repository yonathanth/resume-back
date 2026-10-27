import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireAuth } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import { comparePassword } from "../../services/auth.service";
import { signAccessToken } from "../../services/token.service";
import { createSession } from "../../services/session.service";
import { recordAudit } from "../../services/audit.service";
import { isAdminRole, permissionsFor } from "../../services/admin/permissions";
import { createRateLimiter } from "../../utils/rate-limit";
import { markSignedIn, setRefreshCookie } from "../auth.routes";
import { adminWriteLimiter, parseOr400, sendRateLimited } from "./helpers";
import { adminOverviewRoutes } from "./overview.routes";
import { adminUserRoutes } from "./users.routes";
import { adminEntitlementRoutes } from "./entitlements.routes";
import { adminBillingRoutes } from "./billing.routes";
import { adminSettingsRoutes } from "./settings.routes";
import { adminNotificationRoutes } from "./notifications.routes";
import { adminAiRoutes } from "./ai.routes";
import { adminAuditRoutes } from "./audit.routes";
import { adminInsightsRoutes } from "./insights.routes";
import { adminFeedbackRoutes } from "./feedback.routes";

// Every /api/v1/admin route except the sign-in itself runs behind:
//   1. requireAuth — valid access token, account exists and isn't suspended
//   2. the admin check — role read from the database (never the token/request)
//   3. per-route requirePermission(...) for the specific action
//   4. a per-admin cap on write requests
// There is no endpoint that creates admins or changes roles; that is only
// possible from the server with `npm run admin:create`.

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

// Brute-force protection for the admin sign-in, per IP and per email.
const adminLoginLimiter = createRateLimiter("admin-login", [
  { ms: 15 * 60 * 1000, max: 10 },
  { ms: 60 * 60 * 1000, max: 30 },
]);

export async function adminRoutes(app: FastifyInstance) {
  // The admin sign-in. Same password check and the same session (access
  // token + refresh cookie) as the normal login — but only ADMIN accounts
  // get through, every attempt is audited, and attempts are rate limited.
  // A non-admin gets the same "invalid credentials" answer as a wrong
  // password, so this can't be used to find out who the admins are.
  app.post("/api/v1/admin/auth/login", async (request, reply) => {
    const body = parseOr400(loginSchema, request.body, reply);
    if (!body) return;

    const limit = await adminLoginLimiter.take([`ip:${request.ip}`, `email:${body.email}`]);
    if (!limit.ok) return sendRateLimited(reply, limit.retryAfterSeconds);

    const user = await prisma.user.findFirst({ where: { email: { equals: body.email, mode: "insensitive" } } });
    const passwordOk = Boolean(user?.passwordHash && (await comparePassword(body.password, user.passwordHash)));

    if (!user || !passwordOk || !isAdminRole(user.role) || user.status !== "ACTIVE") {
      await recordAudit({
        actor: { id: null, email: body.email },
        action: "admin.login_failed",
        targetType: "user",
        targetId: user?.id,
        summary: !user || !passwordOk ? "Wrong email or password" : !isAdminRole(user.role) ? "Not an admin account" : "Account suspended",
        request,
      });
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    await adminLoginLimiter.reset(`email:${body.email}`);
    const accessToken = signAccessToken(user.id);
    setRefreshCookie(reply, await createSession(user.id));
    await markSignedIn(user.id);
    await recordAudit({ actor: { id: user.id, email: user.email }, action: "admin.login", targetType: "user", targetId: user.id, request });

    return reply.send({
      data: { accessToken, admin: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } },
      error: null,
    });
  });

  await app.register(async (scope) => {
    scope.addHook("preHandler", requireAuth);
    scope.addHook("preHandler", async (request, reply) => {
      if (!isAdminRole(request.userRole)) {
        return sendError(reply, 403, "FORBIDDEN", "Admin access required");
      }
      const admin = await prisma.user.findUnique({ where: { id: request.userId }, select: { id: true, email: true } });
      if (!admin) return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
      request.admin = admin;

      if (request.method !== "GET") {
        const limit = await adminWriteLimiter.take([admin.id]);
        if (!limit.ok) return sendRateLimited(reply, limit.retryAfterSeconds);
      }
    });

    scope.get("/api/v1/admin/me", async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.userId },
        select: { id: true, email: true, fullName: true, role: true, lastLoginAt: true, passwordHash: true },
      });
      if (!user) return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
      return reply.send({
        data: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          hasPassword: Boolean(user.passwordHash),
          lastLoginAt: user.lastLoginAt,
          permissions: permissionsFor(user.role),
        },
        error: null,
      });
    });

    await scope.register(adminOverviewRoutes);
    await scope.register(adminUserRoutes);
    await scope.register(adminEntitlementRoutes);
    await scope.register(adminBillingRoutes);
    await scope.register(adminSettingsRoutes);
    await scope.register(adminNotificationRoutes);
    await scope.register(adminAiRoutes);
    await scope.register(adminAuditRoutes);
    await scope.register(adminInsightsRoutes);
    await scope.register(adminFeedbackRoutes);
  });
}
