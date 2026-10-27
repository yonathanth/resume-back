import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requirePermission } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import { EXEMPTION_KEYS, GRANTABLE_FEATURES } from "../../services/access.service";
import { FLOW_TYPES } from "../../services/settings.service";
import { audit, paged, pageArgs, paginationSchema, parseOr400, reasonSchema, uuidParam } from "./helpers";

// Manual access grants. A grant is its own record with an owner, a reason
// and an optional end — it never creates or edits a payment or the
// subscription fields, so "complimentary Pro" can't be mistaken for revenue
// and, when it ends, the user's access falls back to what billing says.

const MAX_DAYS = 3650;

const common = {
  reason: reasonSchema,
  note: z.string().trim().max(1000).optional(),
  // Either a duration from now or an explicit end; neither = no end date.
  durationDays: z.number().int().min(1).max(MAX_DAYS).optional(),
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .optional(),
};

const grantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRO_ACCESS"), ...common }),
  z.object({ kind: z.literal("PLUS_ACCESS"), ...common }),
  z.object({ kind: z.literal("LIFETIME_PLUS"), ...common }),
  z.object({ kind: z.literal("FEATURE"), feature: z.enum(GRANTABLE_FEATURES), ...common }),
  z.object({
    kind: z.literal("LIMIT_ADJUSTMENT"),
    flow: z.enum(FLOW_TYPES),
    amount: z
      .number()
      .int()
      .min(-1000)
      .max(1000)
      .refine((v) => v !== 0, "Amount can't be 0"),
    ...common,
  }),
  z.object({ kind: z.literal("EXEMPTION"), feature: z.enum(EXEMPTION_KEYS), ...common }),
]);

const updateSchema = z.object({
  // New end date (ISO), or null for no end.
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .nullable()
    .optional(),
  extendDays: z.number().int().min(1).max(MAX_DAYS).optional(),
  note: z.string().trim().max(1000).optional(),
  reason: reasonSchema,
});

const listQuery = paginationSchema.extend({
  state: z.enum(["active", "expired", "revoked", "all"]).default("active"),
  kind: z.enum(["PRO_ACCESS", "PLUS_ACCESS", "LIFETIME_PLUS", "FEATURE", "LIMIT_ADJUSTMENT", "EXEMPTION"]).optional(),
  userId: z.string().uuid().optional(),
});

function resolveExpiry(input: { durationDays?: number; expiresAt?: string }, now: Date): Date | null | { error: string } {
  if (input.durationDays && input.expiresAt) return { error: "Give either durationDays or expiresAt, not both" };
  if (input.durationDays) return new Date(now.getTime() + input.durationDays * 24 * 60 * 60 * 1000);
  if (input.expiresAt) {
    const at = new Date(input.expiresAt);
    if (at.getTime() <= now.getTime()) return { error: "The end date must be in the future" };
    if (at.getTime() > now.getTime() + MAX_DAYS * 24 * 60 * 60 * 1000) return { error: "The end date is too far in the future" };
    return at;
  }
  return null;
}

function describe(e: { kind: string; feature: string | null; flow: string | null; amount: number | null }) {
  switch (e.kind) {
    case "PRO_ACCESS":
      return "Pro access";
    case "PLUS_ACCESS":
      return "Plus access";
    case "LIFETIME_PLUS":
      return "Plus Lifetime";
    case "FEATURE":
      return `Feature: ${e.feature}`;
    case "LIMIT_ADJUSTMENT":
      return `${(e.amount ?? 0) > 0 ? "+" : ""}${e.amount} free CVs`;
    default:
      return `Exemption: ${e.feature}`;
  }
}

export async function adminEntitlementRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/entitlements", { preHandler: requirePermission("users:read") }, async (request, reply) => {
    const query = parseOr400(listQuery, request.query, reply);
    if (!query) return;
    const now = new Date();
    const where: Prisma.EntitlementWhereInput = {
      ...(query.kind && { kind: query.kind }),
      ...(query.userId && { userId: query.userId }),
      ...(query.state === "active" && { revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
      ...(query.state === "expired" && { revokedAt: null, expiresAt: { lte: now } }),
      ...(query.state === "revoked" && { revokedAt: { not: null } }),
    };
    const [total, items] = await Promise.all([
      prisma.entitlement.count({ where }),
      prisma.entitlement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...pageArgs(query),
        include: { user: { select: { email: true, fullName: true } } },
      }),
    ]);
    return reply.send({
      data: paged(
        items.map((e) => ({ ...e, label: describe(e) })),
        total,
        query
      ),
      error: null,
    });
  });

  app.post("/api/v1/admin/users/:id/entitlements", { preHandler: requirePermission("entitlements:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(grantSchema, request.body, reply);
    if (!params || !body) return;

    const user = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true, email: true } });
    if (!user) return sendError(reply, 404, "USER_NOT_FOUND", "User not found");

    const now = new Date();
    const expiresAt = resolveExpiry(body, now);
    if (expiresAt && "error" in expiresAt) return sendError(reply, 400, "VALIDATION_ERROR", expiresAt.error);

    const grant = await prisma.entitlement.create({
      data: {
        userId: user.id,
        kind: body.kind,
        feature: "feature" in body ? body.feature : null,
        flow: "flow" in body ? body.flow : null,
        amount: "amount" in body ? body.amount : null,
        reason: body.reason,
        note: body.note || null,
        startsAt: now,
        expiresAt,
        createdById: request.admin.id,
        createdByEmail: request.admin.email,
      },
    });
    await audit(request, {
      action: "entitlement.grant",
      targetType: "user",
      targetId: user.id,
      summary: `${describe(grant)}${expiresAt ? ` until ${expiresAt.toISOString()}` : " (no end date)"} — ${body.reason}`,
      metadata: { entitlementId: grant.id, after: grant },
    });
    return reply.code(201).send({ data: { ...grant, label: describe(grant) }, error: null });
  });

  // Extend or shorten (new end date / +days), or edit the internal note.
  app.patch("/api/v1/admin/entitlements/:id", { preHandler: requirePermission("entitlements:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(updateSchema, request.body, reply);
    if (!params || !body) return;

    const grant = await prisma.entitlement.findUnique({ where: { id: params.id } });
    if (!grant) return sendError(reply, 404, "ENTITLEMENT_NOT_FOUND", "Grant not found");
    if (grant.revokedAt) return sendError(reply, 409, "ENTITLEMENT_REVOKED", "A revoked grant can't be changed. Create a new one");
    if (body.expiresAt !== undefined && body.extendDays) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Give either expiresAt or extendDays, not both");
    }

    const now = new Date();
    const data: Prisma.EntitlementUpdateInput = {};
    if (body.extendDays) {
      // Extending an expired grant restarts it from now.
      const base = grant.expiresAt && grant.expiresAt > now ? grant.expiresAt : now;
      if (!grant.expiresAt) return sendError(reply, 400, "NO_END_DATE", "This grant has no end date to extend");
      data.expiresAt = new Date(base.getTime() + body.extendDays * 24 * 60 * 60 * 1000);
    } else if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        data.expiresAt = null;
      } else {
        const at = new Date(body.expiresAt);
        if (at <= now) return sendError(reply, 400, "VALIDATION_ERROR", "The end date must be in the future (revoke the grant to end it now)");
        data.expiresAt = at;
      }
    }
    if (body.note !== undefined) data.note = body.note || null;
    if (Object.keys(data).length === 0) return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to change");

    const updated = await prisma.entitlement.update({ where: { id: grant.id }, data });
    await audit(request, {
      action: "entitlement.update",
      targetType: "user",
      targetId: grant.userId,
      summary: `${describe(grant)}: ${body.reason}`,
      metadata: {
        entitlementId: grant.id,
        before: { expiresAt: grant.expiresAt, note: grant.note },
        after: { expiresAt: updated.expiresAt, note: updated.note },
      },
    });
    return reply.send({ data: { ...updated, label: describe(updated) }, error: null });
  });

  app.post("/api/v1/admin/entitlements/:id/revoke", { preHandler: requirePermission("entitlements:write") }, async (request, reply) => {
    const params = parseOr400(uuidParam, request.params, reply);
    const body = params && parseOr400(z.object({ reason: reasonSchema }), request.body, reply);
    if (!params || !body) return;

    const grant = await prisma.entitlement.findUnique({ where: { id: params.id } });
    if (!grant) return sendError(reply, 404, "ENTITLEMENT_NOT_FOUND", "Grant not found");
    if (grant.revokedAt) return sendError(reply, 409, "ENTITLEMENT_REVOKED", "This grant is already revoked");

    const updated = await prisma.entitlement.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedById: request.admin.id, revokeReason: body.reason },
    });
    await audit(request, {
      action: "entitlement.revoke",
      targetType: "user",
      targetId: grant.userId,
      summary: `${describe(grant)}: ${body.reason}`,
      metadata: { entitlementId: grant.id },
    });
    return reply.send({ data: { ...updated, label: describe(updated) }, error: null });
  });
}
