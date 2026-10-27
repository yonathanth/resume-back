import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/client";
import { verifyAccessToken } from "../services/token.service";
import { sendError } from "../utils/http-error";
import { roleHasPermission, type Permission } from "../services/admin/permissions";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    userRole: string;
  }
}

export const ACCOUNT_SUSPENDED_MESSAGE = "This account has been suspended. Contact support if you think this is a mistake.";

// Verifies the access token, then re-reads the account's status and role on
// every request: a suspension (or a role change) takes effect immediately,
// not when the 15-minute access token runs out.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return sendError(reply, 401, "UNAUTHORIZED", "Missing or invalid Authorization header");
  }

  let userId: string;
  try {
    userId = verifyAccessToken(header.slice(7)).userId;
  } catch {
    return sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired access token");
  }

  const account = await prisma.user.findUnique({ where: { id: userId }, select: { status: true, role: true } });
  if (!account) {
    return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
  }
  if (account.status === "SUSPENDED") {
    return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
  }

  request.userId = userId;
  request.userRole = account.role;
}

/**
 * preHandler for admin endpoints. Must run after requireAuth. The role comes
 * from the database (requireAuth), never from the token or the request, so
 * a user can't grant themselves access by editing anything client-side.
 */
export function requirePermission(permission: Permission) {
  return async function checkPermission(request: FastifyRequest, reply: FastifyReply) {
    if (!roleHasPermission(request.userRole, permission)) {
      return sendError(reply, 403, "FORBIDDEN", "You don't have permission to do that");
    }
  };
}
