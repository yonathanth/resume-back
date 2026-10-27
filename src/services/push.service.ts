import webpush, { WebPushError } from "web-push";
import { prisma } from "../db/client";
import { env } from "../config/env";

// Browser push via the standard Web Push protocol (VAPID). Separate from
// in-app notifications: a push only reaches browsers where the user opted in
// (Settings → Notifications), and the in-app copy is always created too.
// Push is off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT
// are all set.

const MAX_FAILURES = 5;

let configured: boolean | null = null;

export function isPushConfigured(): boolean {
  if (configured !== null) return configured;
  configured = false;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    try {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      configured = true;
    } catch (err) {
      console.error("[push] invalid VAPID configuration — push disabled:", err instanceof Error ? err.message : err);
    }
  }
  return configured;
}

export function pushPublicKey(): string | null {
  return isPushConfigured() ? env.VAPID_PUBLIC_KEY! : null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string | null;
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

/** Sends to every browser the user subscribed. Expired subscriptions are deleted. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (!isPushConfigured()) return result;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  const body = JSON.stringify({ title: payload.title, body: payload.body.slice(0, 500), url: payload.url ?? "/dashboard", tag: payload.tag });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 24 * 60 * 60 });
      result.sent++;
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
    } catch (err) {
      result.failed++;
      // 404/410: the browser dropped the subscription — it will never work again.
      const gone = err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410);
      if (gone || sub.failureCount + 1 >= MAX_FAILURES) {
        await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
        result.removed++;
      } else {
        await prisma.pushSubscription.update({ where: { id: sub.id }, data: { failureCount: { increment: 1 } } });
      }
    }
  }
  return result;
}
