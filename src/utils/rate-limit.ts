import { prisma } from "../db/client";

// Sliding-window rate limits stored in Postgres (the RateLimitHit table), so
// every server instance shares the same counts. A per-key advisory lock
// serializes the check-then-record step, so two instances (or two requests)
// can't both slip under a cap at the same moment.

export interface RateWindow {
  ms: number;
  max: number;
}

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Records a hit for every key, or returns how long to wait if any key is
 * already at a cap (then nothing is recorded). Keys are full keys, already
 * namespaced by the caller (see createRateLimiter).
 */
export async function takeRateLimit(keys: string[], windows: RateWindow[]): Promise<RateResult> {
  const uniqueKeys = [...new Set(keys)].sort(); // a fixed lock order can't deadlock
  const longest = Math.max(...windows.map((w) => w.ms));

  return prisma.$transaction(async (tx) => {
    for (const key of uniqueKeys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }

    const now = Date.now();
    for (const key of uniqueKeys) {
      const recent = await tx.rateLimitHit.findMany({
        where: { key, createdAt: { gt: new Date(now - longest) } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      for (const window of windows) {
        const inWindow = recent.filter((hit) => now - hit.createdAt.getTime() < window.ms);
        if (inWindow.length >= window.max) {
          const oldest = inWindow[0].createdAt.getTime();
          return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + window.ms - now) / 1000)) };
        }
      }
    }

    const createdAt = new Date(now);
    await tx.rateLimitHit.createMany({ data: uniqueKeys.map((key) => ({ key, createdAt })) });
    return { ok: true };
  });
}

/** Deletes a limiter's rows older than its longest window. */
async function pruneRateLimitHits(prefix: string, longestMs: number) {
  await prisma.rateLimitHit.deleteMany({
    where: { key: { startsWith: prefix }, createdAt: { lt: new Date(Date.now() - longestMs) } },
  });
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** A named limiter with fixed windows. `name` keeps its keys apart from other limiters'. */
export function createRateLimiter(name: string, windows: RateWindow[]) {
  const prefix = `${name}:`;
  const longest = Math.max(...windows.map((w) => w.ms));

  setInterval(() => {
    pruneRateLimitHits(prefix, longest).catch((err) => console.error(`[rate-limit] prune ${name} failed`, err));
  }, PRUNE_INTERVAL_MS).unref();

  return {
    /** Records a hit for every key, or returns how long to wait if any key is capped. */
    take(keys: string[]): Promise<RateResult> {
      return takeRateLimit(
        keys.map((key) => prefix + key),
        windows
      );
    },
    /** Forgets a key (e.g. after a successful sign-in). */
    async reset(key: string): Promise<void> {
      await prisma.rateLimitHit.deleteMany({ where: { key: prefix + key } });
    },
  };
}
