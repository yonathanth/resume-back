import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import { requirePermission } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/http-error";
import {
  DEFAULT_SETTINGS,
  FEATURE_INFO,
  SETTING_KEYS,
  SettingValidationError,
  getSettings,
  isSettingKey,
  updateSetting,
} from "../../services/settings.service";
import { emailConfigStatus } from "../../services/email";
import { isPushConfigured } from "../../services/push.service";
import { getPolarOrganization } from "../../services/polar/admin.service";
import { currentModelName, currentProviderName } from "../../services/ai/usage";
import { billingProUserFilter, proUserFilter } from "../../services/notification.service";
import { audit, parseOr400 } from "./helpers";

// Platform settings and health. Settings are a fixed set of validated keys
// (services/settings.service.ts) — there is no way to write arbitrary
// configuration, run commands or read environment variables from here. The
// health view reports whether each integration is *configured* and reachable,
// never its keys.

export async function adminSettingsRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/settings", { preHandler: requirePermission("overview:read") }, async (_request, reply) => {
    const [values, rows] = await Promise.all([getSettings(), prisma.platformSetting.findMany()]);
    const updaters = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.updatedById).filter((v): v is string => Boolean(v)) } },
      select: { id: true, email: true },
    });
    const emailBy = new Map(updaters.map((u) => [u.id, u.email]));
    return reply.send({
      data: {
        values,
        defaults: DEFAULT_SETTINGS,
        features: FEATURE_INFO,
        meta: Object.fromEntries(
          rows.map((r) => [r.key, { updatedAt: r.updatedAt, updatedBy: r.updatedById ? emailBy.get(r.updatedById) ?? r.updatedById : null }])
        ),
      },
      error: null,
    });
  });

  // How many users a limits/features change would touch — shown before saving.
  app.get("/api/v1/admin/settings/impact", { preHandler: requirePermission("overview:read") }, async (_request, reply) => {
    const now = new Date();
    const [total, pro, paid, suspended] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: proUserFilter(now) }),
      prisma.user.count({ where: billingProUserFilter(now) }),
      prisma.user.count({ where: { status: "SUSPENDED" } }),
    ]);
    return reply.send({ data: { total, pro, paid, free: total - pro, suspended }, error: null });
  });

  app.put("/api/v1/admin/settings/:key", { preHandler: requirePermission("settings:write") }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!isSettingKey(key)) return sendError(reply, 404, "UNKNOWN_SETTING", `Unknown setting. Known: ${SETTING_KEYS.join(", ")}`);
    const body = parseOr400(z.object({ value: z.unknown(), reason: z.string().trim().max(500).optional() }), request.body, reply);
    if (!body) return;
    try {
      const { before, after } = await updateSetting(key, body.value, request.admin.id);
      await audit(request, { action: `settings.update.${key}`, targetType: "setting", targetId: key, summary: body.reason, metadata: { before, after } });
      return reply.send({ data: { key, value: after }, error: null });
    } catch (err) {
      if (err instanceof SettingValidationError) return sendError(reply, 400, "VALIDATION_ERROR", err.message);
      throw err;
    }
  });

  app.get("/api/v1/admin/health", { preHandler: requirePermission("overview:read") }, async (_request, reply) => {
    const dbStarted = Date.now();
    let database: { ok: boolean; latencyMs: number | null; error?: string };
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = { ok: true, latencyMs: Date.now() - dbStarted };
    } catch (err) {
      database = { ok: false, latencyMs: null, error: err instanceof Error ? err.message.slice(0, 200) : "failed" };
    }

    const polarStarted = Date.now();
    const org = await getPolarOrganization();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [failedWebhooks, failedEmails, aiErrors] = await Promise.all([
      prisma.webhookEvent.count({ where: { status: { in: ["failed", "unmatched"] }, createdAt: { gte: since } } }),
      prisma.emailLog.count({ where: { status: "failed", createdAt: { gte: since } } }),
      prisma.aiUsageEvent.count({ where: { status: { in: ["provider_error", "timeout", "provider_rate_limited"] }, createdAt: { gte: since } } }),
    ]);

    return reply.send({
      data: {
        checkedAt: new Date(),
        environment: env.NODE_ENV,
        database,
        email: emailConfigStatus(),
        push: { configured: isPushConfigured() },
        ai: { provider: currentProviderName(), model: currentModelName(), keyConfigured: true },
        polar: { environment: env.POLAR_SERVER, reachable: Boolean(org), organization: org?.name ?? null, latencyMs: org ? Date.now() - polarStarted : null },
        chapa: { configured: Boolean(env.CHAPA_SECRET_KEY), apiVersion: env.CHAPA_API_VERSION },
        google: { signInConfigured: Boolean(env.GOOGLE_CLIENT_ID), redirectConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) },
        last24h: { failedWebhooks, failedEmails, aiErrors },
      },
      error: null,
    });
  });
}
