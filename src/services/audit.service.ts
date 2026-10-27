import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

// The admin audit log. Callers pass before/after snapshots of what changed;
// keys that look like secrets are stripped as a last line of defence, so a
// careless caller still can't write a password or token into the log.

const SECRET_KEY_PATTERN = /password|secret|token|hash|apikey|api_key|authorization|cookie|p256dh|auth$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export interface AuditActor {
  id: string | null;
  email: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  request?: FastifyRequest;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorId: entry.actor.id,
        actorEmail: entry.actor.email,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        summary: entry.summary?.slice(0, 500) ?? null,
        metadata: entry.metadata ? (scrub(entry.metadata) as Prisma.InputJsonValue) : undefined,
        ip: entry.request?.ip ?? null,
        userAgent: (entry.request?.headers["user-agent"] as string | undefined)?.slice(0, 300) ?? null,
      },
    });
  } catch (err) {
    // An audit write must not be silently lost, but it also must not undo an
    // action that already happened — log loudly instead.
    console.error("[audit] failed to record entry", entry.action, err instanceof Error ? err.message : err);
  }
}
