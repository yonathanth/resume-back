import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { getSettings } from "./settings.service";
import { sendEmail } from "./email/send";
import { announcementEmail } from "./email/templates";
import { isPushConfigured, sendPushToUser } from "./push.service";

// Admin announcements and direct messages, over up to three channels:
//   in_app — a UserNotification row per recipient (bell in the dashboard)
//   email  — verified addresses only; "product" announcements skip users who
//            unsubscribed, "service" notices (maintenance, account) don't
//   push   — browsers the user opted in on (when VAPID is configured)
// Recipients are resolved when the notification is created. Email and push
// go out in the background, throttled; their results are counted on the
// Notification row so the admin can see failures.

export const CHANNELS = ["in_app", "email", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

export const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("free") }),
  z.object({ type: z.literal("pro") }),
  z.object({ type: z.literal("paid") }),
  z.object({ type: z.literal("verified") }),
  z.object({ type: z.literal("beta") }),
  z.object({ type: z.literal("new"), days: z.number().int().min(1).max(365) }),
  z.object({ type: z.literal("users"), userIds: z.array(z.string().uuid()).min(1).max(500) }),
]);
export type Audience = z.infer<typeof audienceSchema>;

// Relative app paths ("/dashboard/upgrade") or absolute https links only — a
// javascript: or data: URL must never reach a link users click.
export const actionUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//")) || /^https:\/\/[^\s]+$/i.test(v), {
    message: "Use a path starting with / or an https:// link",
  });

export const createNotificationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  actionUrl: actionUrlSchema.optional().nullable(),
  audience: audienceSchema,
  channels: z.array(z.enum(CHANNELS)).min(1),
  emailCategory: z.enum(["product", "service"]).default("product"),
});
export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;

// A grant that gives a paid plan: Pro, Plus, or Plus Lifetime.
function activeProGrantFilter(now: Date): Prisma.EntitlementWhereInput {
  return { kind: { in: ["PRO_ACCESS", "PLUS_ACCESS", "LIFETIME_PLUS"] }, revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

const billingProFilter = (now: Date): Prisma.UserWhereInput => ({
  subscriptionStatus: "active",
  OR: [{ subscriptionCurrentPeriodEnd: null }, { subscriptionCurrentPeriodEnd: { gte: now } }],
});

/** Users on a paid plan (Plus or Pro) right now, paid for or granted — the same rule as access.service.ts. */
export function proUserFilter(now: Date): Prisma.UserWhereInput {
  return { OR: [billingProFilter(now), { entitlements: { some: activeProGrantFilter(now) } }] };
}

export function billingProUserFilter(now: Date): Prisma.UserWhereInput {
  return billingProFilter(now);
}

// The negations are spelled out rather than wrapped in NOT {...}: in SQL,
// NOT (status = 'active') is NULL — not true — for a user whose status is
// NULL, so a NOT filter would silently drop every never-subscribed user.

/** No paid access right now (never subscribed, not active, or past the period end). */
export function noBillingProUserFilter(now: Date): Prisma.UserWhereInput {
  return {
    OR: [
      { subscriptionStatus: null },
      { subscriptionStatus: { not: "active" } },
      { subscriptionCurrentPeriodEnd: { lt: now } },
    ],
  };
}

/** On Free right now — no paid plan, neither paid for nor granted. */
export function freeUserFilter(now: Date): Prisma.UserWhereInput {
  return { AND: [noBillingProUserFilter(now), { entitlements: { none: activeProGrantFilter(now) } }] };
}

/** A paid plan only through a grant (an admin's, or Plus Lifetime). */
export function grantOnlyProUserFilter(now: Date): Prisma.UserWhereInput {
  return { AND: [noBillingProUserFilter(now), { entitlements: { some: activeProGrantFilter(now) } }] };
}

export function audienceWhere(audience: Audience, now: Date = new Date()): Prisma.UserWhereInput {
  // Suspended accounts never receive announcements.
  const base: Prisma.UserWhereInput = { status: "ACTIVE" };
  switch (audience.type) {
    case "all":
      return base;
    case "pro":
      return { AND: [base, proUserFilter(now)] };
    case "free":
      return { AND: [base, freeUserFilter(now)] };
    case "paid":
      return { AND: [base, billingProFilter(now)] };
    case "verified":
      return { ...base, emailVerifiedAt: { not: null } };
    case "beta":
      return {
        ...base,
        entitlements: {
          some: { kind: "FEATURE", feature: "beta", revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        },
      };
    case "new":
      return { ...base, createdAt: { gte: new Date(now.getTime() - audience.days * 24 * 60 * 60 * 1000) } };
    case "users":
      return { ...base, id: { in: audience.userIds } };
  }
}

export async function countAudience(audience: Audience) {
  const where = audienceWhere(audience);
  const [total, emailable, emailableService] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.count({ where: { AND: [where, { emailVerifiedAt: { not: null }, emailAnnouncementsOptOut: false }] } }),
    prisma.user.count({ where: { AND: [where, { emailVerifiedAt: { not: null } }] } }),
  ]);
  return { total, emailableProduct: emailable, emailableService };
}

// One-click unsubscribe links: an HMAC of the user id, so the link works
// without signing in and can't be forged for someone else.
function unsubscribeSignature(userId: string): string {
  return crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(`unsubscribe:${userId}`).digest("base64url");
}

export function unsubscribeUrl(userId: string): string {
  return `${env.FRONTEND_URL}/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeSignature(userId)}`;
}

export function verifyUnsubscribe(userId: string, signature: string): boolean {
  const expected = Buffer.from(unsubscribeSignature(userId));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function absoluteUrl(actionUrl: string | null | undefined): string | null {
  if (!actionUrl) return null;
  return actionUrl.startsWith("/") ? `${env.FRONTEND_URL}${actionUrl}` : actionUrl;
}

// Resend's default limit is 2 requests per second.
const EMAIL_SEND_INTERVAL_MS = 550;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// While a server delivers a notification it keeps renewing Notification.leaseUntil.
// If that server stops mid-send, the lease lapses and any server resumes it
// (resumeStalledDeliveries) — skipping recipients already in EmailLog, so
// nobody gets the email twice. A repeated push carries the same tag, which
// the browser shows as one notification.
const LEASE_MS = 2 * 60 * 1000;
const LEASE_RENEW_MS = 30 * 1000;
// A delivery stalled for longer than this is closed as failed instead of
// going out late.
const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 60 * 1000;

const leaseExpiry = () => new Date(Date.now() + LEASE_MS);

type Recipient = { id: string; email: string; emailVerifiedAt: Date | null; emailAnnouncementsOptOut: boolean };
const recipientSelect = { id: true, email: true, emailVerifiedAt: true, emailAnnouncementsOptOut: true } as const;

export interface Actor {
  id: string;
  email: string;
}

/**
 * Creates the notification and its in-app copies now, and starts email/push
 * delivery in the background. Returns the Notification row.
 */
export async function createNotification(input: CreateNotificationInput, actor: Actor) {
  const channels = [...new Set(input.channels)];
  const recipients = await prisma.user.findMany({
    where: audienceWhere(input.audience),
    select: recipientSelect,
  });
  const sending = channels.some((c) => c !== "in_app") && recipients.length > 0;

  const notification = await prisma.notification.create({
    data: {
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl ?? null,
      audience: input.audience as Prisma.InputJsonValue,
      channels,
      emailCategory: input.emailCategory,
      createdById: actor.id,
      createdByEmail: actor.email,
      recipientCount: recipients.length,
      status: sending ? "sending" : "done",
      completedAt: sending ? null : new Date(),
      leaseUntil: sending ? leaseExpiry() : null,
    },
  });

  if (channels.includes("in_app")) {
    for (let i = 0; i < recipients.length; i += 1000) {
      await prisma.userNotification.createMany({
        data: recipients.slice(i, i + 1000).map((r) => ({ notificationId: notification.id, userId: r.id })),
        skipDuplicates: true,
      });
    }
  }

  if (notification.status === "sending") {
    void deliverInBackground(notification.id, input, channels, recipients);
  }
  return notification;
}

/** Email outcomes so far, from EmailLog — the record that survives a restart. */
async function loggedEmailCounts(notificationId: string) {
  const rows = await prisma.emailLog.groupBy({ by: ["status"], where: { notificationId }, _count: { _all: true } });
  const count = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
  return { sent: count("sent"), failed: count("failed"), skipped: count("skipped") };
}

async function deliverInBackground(
  notificationId: string,
  input: CreateNotificationInput,
  channels: Channel[],
  recipients: Recipient[]
) {
  const counts = { emailSkipped: 0, pushSent: 0, pushFailed: 0 };
  let leaseRenewedAt = Date.now();
  const renewLease = async () => {
    if (Date.now() - leaseRenewedAt < LEASE_RENEW_MS) return;
    leaseRenewedAt = Date.now();
    await prisma.notification.update({ where: { id: notificationId }, data: { leaseUntil: leaseExpiry() } });
  };
  const finish = async (status: "done" | "failed") => {
    const email = await loggedEmailCounts(notificationId);
    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        emailSent: email.sent,
        emailFailed: email.failed,
        emailSkipped: email.skipped + counts.emailSkipped,
        pushSent: counts.pushSent,
        pushFailed: counts.pushFailed,
        status,
        completedAt: new Date(),
        leaseUntil: null,
      },
    });
  };

  try {
    if (channels.includes("email")) {
      const { maxEmailRecipients } = (await getSettings()).notifications;
      // On a resumed delivery, whoever already has a log entry was handled.
      const handled = new Set(
        (await prisma.emailLog.findMany({ where: { notificationId }, select: { userId: true } })).map((log) => log.userId)
      );
      let attempted = handled.size;
      for (const r of recipients) {
        if (handled.has(r.id)) continue;
        const optedOut = input.emailCategory === "product" && r.emailAnnouncementsOptOut;
        if (!r.emailVerifiedAt || optedOut || attempted >= maxEmailRecipients) {
          counts.emailSkipped++;
          continue;
        }
        attempted++;
        await renewLease();
        // Outcomes are counted from EmailLog at the end (sendEmail logs every one).
        await sendEmail({
          to: r.email,
          userId: r.id,
          kind: "announcement",
          notificationId,
          ...announcementEmail({
            title: input.title,
            body: input.body,
            actionUrl: absoluteUrl(input.actionUrl),
            unsubscribeUrl: input.emailCategory === "product" ? unsubscribeUrl(r.id) : null,
          }),
          headers: input.emailCategory === "product" ? { "List-Unsubscribe": `<${unsubscribeUrl(r.id)}>` } : undefined,
        });
        await sleep(EMAIL_SEND_INTERVAL_MS);
      }
    }

    if (channels.includes("push") && isPushConfigured()) {
      for (const r of recipients) {
        await renewLease();
        const result = await sendPushToUser(r.id, { title: input.title, body: input.body, url: input.actionUrl, tag: notificationId });
        counts.pushSent += result.sent;
        counts.pushFailed += result.failed;
      }
    }

    await finish("done");
  } catch (err) {
    console.error("[notifications] delivery failed", notificationId, err);
    await finish("failed").catch(() => {});
  }
}

/** Who a stalled notification goes to, re-read from the database. */
async function resolveRecipients(notification: { id: string; audience: Prisma.JsonValue; channels: string[]; createdAt: Date }): Promise<Recipient[]> {
  if (notification.channels.includes("in_app")) {
    // The in-app rows are exactly the recipients resolved when it was created.
    const rows = await prisma.userNotification.findMany({
      where: { notificationId: notification.id },
      select: { user: { select: recipientSelect } },
    });
    return rows.map((row) => row.user);
  }
  const audience = audienceSchema.safeParse(notification.audience);
  if (!audience.success) return [];
  return prisma.user.findMany({ where: audienceWhere(audience.data, notification.createdAt), select: recipientSelect });
}

/**
 * Picks up deliveries whose server stopped mid-send (restart, crash, deploy).
 * The claim is a conditional update on the lapsed lease, so with several
 * servers only one resumes each notification.
 */
export async function resumeStalledDeliveries(): Promise<void> {
  const now = new Date();
  const lapsed: Prisma.NotificationWhereInput = { status: "sending", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
  const stalled = await prisma.notification.findMany({ where: lapsed });

  for (const notification of stalled) {
    const { count } = await prisma.notification.updateMany({
      where: { id: notification.id, ...lapsed },
      data: { leaseUntil: leaseExpiry() },
    });
    if (count === 0) continue; // another server claimed it

    if (now.getTime() - notification.createdAt.getTime() > MAX_RESUME_AGE_MS) {
      const email = await loggedEmailCounts(notification.id);
      await prisma.notification.update({
        where: { id: notification.id },
        data: { emailSent: email.sent, emailFailed: email.failed, emailSkipped: email.skipped, status: "failed", completedAt: now, leaseUntil: null },
      });
      continue;
    }

    const input = createNotificationSchema.safeParse({
      title: notification.title,
      body: notification.body,
      actionUrl: notification.actionUrl,
      audience: notification.audience,
      channels: notification.channels,
      emailCategory: notification.emailCategory,
    });
    if (!input.success) {
      await prisma.notification.update({ where: { id: notification.id }, data: { status: "failed", completedAt: now, leaseUntil: null } });
      continue;
    }

    console.info("[notifications] resuming stalled delivery", notification.id);
    const recipients = await resolveRecipients(notification);
    void deliverInBackground(notification.id, input.data, [...new Set(input.data.channels)], recipients);
  }
}

/** Runs resumeStalledDeliveries now and every minute after. Call once at server start. */
export function startDeliveryRecovery() {
  const run = () => resumeStalledDeliveries().catch((err) => console.error("[notifications] recovery failed", err));
  void run();
  setInterval(run, RECOVERY_INTERVAL_MS).unref();
}

// ---- What a signed-in user sees ----

export async function listUserNotifications(userId: string, limit = 20) {
  const [items, unreadCount] = await Promise.all([
    prisma.userNotification.findMany({
      where: { userId, dismissedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { notification: { select: { title: true, body: true, actionUrl: true } } },
    }),
    prisma.userNotification.count({ where: { userId, dismissedAt: null, readAt: null } }),
  ]);
  return {
    unreadCount,
    items: items.map((item) => ({
      id: item.id,
      title: item.notification.title,
      body: item.notification.body,
      actionUrl: item.notification.actionUrl,
      createdAt: item.createdAt,
      readAt: item.readAt,
    })),
  };
}
