import type { FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";
import { sendError } from "../../utils/http-error";
import { recordAudit } from "../../services/audit.service";
import { createRateLimiter } from "../../utils/rate-limit";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin scope's preHandler once the caller is confirmed to be an admin. */
    admin: { id: string; email: string };
  }
}

/** Parses `data` with `schema`, replying 400 with the first issue on failure. */
export function parseOr400<T>(schema: ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    sendError(reply, 400, "VALIDATION_ERROR", `${issue?.message ?? "Invalid request"}${where}`);
    return null;
  }
  return parsed.data;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function pageArgs(p: { page: number; pageSize: number }) {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}

export function paged<T>(items: T[], total: number, p: { page: number; pageSize: number }) {
  return { items, total, page: p.page, pageSize: p.pageSize, pageCount: Math.max(1, Math.ceil(total / p.pageSize)) };
}

/** Optional ISO date query params. */
export const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
  .transform((v) => new Date(v));

/** A required, human-written reason for a sensitive action (kept in the audit log). */
export const reasonSchema = z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500);

export const uuidParam = z.object({ id: z.string().uuid("Invalid id") });

export function audit(
  request: FastifyRequest,
  entry: { action: string; targetType?: string; targetId?: string; summary?: string; metadata?: Record<string, unknown> }
) {
  return recordAudit({ actor: { id: request.admin.id, email: request.admin.email }, request, ...entry });
}

// Caps on admin writes, per admin: a generous ceiling that still stops a
// runaway script or a stolen session from doing unbounded damage quickly.
export const adminWriteLimiter = createRateLimiter("admin-write", [
  { ms: 60 * 1000, max: 60 },
  { ms: 60 * 60 * 1000, max: 600 },
]);

// Outbound sends are capped harder (provider quotas, accidental spam).
export const announcementLimiter = createRateLimiter("announcement", [{ ms: 60 * 60 * 1000, max: 10 }]);
export const testEmailLimiter = createRateLimiter("test-email", [{ ms: 60 * 60 * 1000, max: 5 }]);

export function sendRateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  return sendError(reply, 429, "RATE_LIMITED", `Too many requests. Try again in ${retryAfterSeconds} seconds.`);
}

export function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
