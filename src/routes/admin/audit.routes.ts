import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { isoDate, paged, pageArgs, paginationSchema, parseOr400 } from "./helpers";

const auditQuery = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  actor: z.string().trim().max(200).optional(),
  targetId: z.string().trim().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function adminAuditRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/audit", { preHandler: requirePermission("audit:read") }, async (request, reply) => {
    const query = parseOr400(auditQuery, request.query, reply);
    if (!query) return;
    const where: Prisma.AdminAuditLogWhereInput = {
      // "user." matches every user action; "user.suspend" just that one.
      ...(query.action && { action: { startsWith: query.action } }),
      ...(query.actor && { actorEmail: { contains: query.actor, mode: "insensitive" } }),
      ...(query.targetId && { targetId: query.targetId }),
      ...((query.from || query.to) && { createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) } }),
    };
    const [total, items, actions] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(query) }),
      prisma.adminAuditLog.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { action: "asc" } }),
    ]);
    return reply.send({ data: { ...paged(items, total, query), actions: actions.map((a) => a.action) }, error: null });
  });
}
