import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { getSettings } from "./settings.service";
import { getEmailProvider } from "./email";
import { sendEmail } from "./email/send";
import { downloadReminderEmail, firstCvNudgeEmail, welcomeEmail, type RenderedEmail } from "./email/templates";
import { unsubscribeUrl } from "./notification.service";

// Lifecycle emails for new accounts, sent by a background loop on every
// server (startLifecycleEmails):
//   welcome           — once onboarding is done (or 30 minutes after sign-up)
//   first_cv_nudge    — a day after sign-up, if they still have no CV
//   download_reminder — a CV made a day or more ago that was never downloaded
// Each goes out at most once per account: a LifecycleEmail row is inserted
// (unique per user + kind) before sending, so several servers never send the
// same email twice. Only verified, active accounts that haven't unsubscribed
// from product emails get them, and only while the admin setting
// "lifecycleEmails.enabled" is on. Accounts from before this existed were
// marked as skipped by the migration.

export type LifecycleKind = "welcome" | "first_cv_nudge" | "download_reminder";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When each email is due, relative to sign-up (and the CV's last edit for the reminder). */
export const LIFECYCLE_TIMING = {
  welcomeAfterSignupMs: 30 * MINUTE,
  welcomeWindowMs: 2 * DAY,
  nudgeAfterSignupMs: DAY,
  nudgeWindowMs: 3 * DAY,
  reminderAfterEditMs: DAY,
  reminderEditWindowMs: 7 * DAY,
  reminderSignupWindowMs: 14 * DAY,
} as const;

const TICK_INTERVAL_MS = 10 * MINUTE;
const FIRST_TICK_DELAY_MS = MINUTE;
// Per tick, across all kinds. The loop catches up on the next tick.
const MAX_EMAILS_PER_TICK = 50;
const CANDIDATE_BATCH = 200;
// Resend's default limit is 2 requests per second (same pace as announcements).
const EMAIL_SEND_INTERVAL_MS = 550;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Recipient = {
  id: string;
  email: string;
  firstName: string | null;
  signupIntent: string | null;
};

const recipientSelect = { id: true, email: true, firstName: true, signupIntent: true } as const;

/** Who may get a lifecycle email at all, and hasn't had this one. */
function eligible(kind: LifecycleKind): Prisma.UserWhereInput {
  return {
    status: "ACTIVE",
    role: "USER",
    emailVerifiedAt: { not: null },
    emailAnnouncementsOptOut: false,
    lifecycleEmails: { none: { kind } },
  };
}

const FLOW_INTENTS = new Set(["create", "tailor", "improve"]);

function intentOf(user: Recipient): "create" | "tailor" | "improve" | null {
  return user.signupIntent && FLOW_INTENTS.has(user.signupIntent) ? (user.signupIntent as "create" | "tailor" | "improve") : null;
}

/** A /go link: signed in, the dashboard opens that flow; signed out, it signs them in first. */
function flowLink(intent: "create" | "tailor" | "improve" | null): string {
  return `${env.FRONTEND_URL}/go/${intent ?? "create"}`;
}

export async function welcomeCandidates(now: Date, take = CANDIDATE_BATCH): Promise<Recipient[]> {
  return prisma.user.findMany({
    where: {
      AND: [
        eligible("welcome"),
        { createdAt: { gte: new Date(now.getTime() - LIFECYCLE_TIMING.welcomeWindowMs) } },
        {
          OR: [
            { onboardingCompletedAt: { not: null } },
            { createdAt: { lte: new Date(now.getTime() - LIFECYCLE_TIMING.welcomeAfterSignupMs) } },
          ],
        },
      ],
    },
    select: recipientSelect,
    orderBy: { createdAt: "asc" },
    take,
  });
}

export async function nudgeCandidates(now: Date, take = CANDIDATE_BATCH): Promise<Recipient[]> {
  const signedUpFrom = new Date(now.getTime() - LIFECYCLE_TIMING.nudgeWindowMs);
  const signedUpBy = new Date(now.getTime() - LIFECYCLE_TIMING.nudgeAfterSignupMs);
  return prisma.$queryRaw<Recipient[]>`
    SELECT u."id", u."email", u."firstName", u."signupIntent"
    FROM "User" u
    WHERE u."status" = 'ACTIVE' AND u."role" = 'USER'
      AND u."emailVerifiedAt" IS NOT NULL AND u."emailAnnouncementsOptOut" = false
      AND u."createdAt" >= ${signedUpFrom} AND u."createdAt" <= ${signedUpBy}
      AND NOT EXISTS (SELECT 1 FROM "CVDocument" d WHERE d."userId" = u."id")
      AND NOT EXISTS (SELECT 1 FROM "LifecycleEmail" l WHERE l."userId" = u."id" AND l."kind" = 'first_cv_nudge')
    ORDER BY u."createdAt" ASC
    LIMIT ${take}`;
}

export async function reminderCandidates(
  now: Date,
  take = CANDIDATE_BATCH
): Promise<(Recipient & { cvId: string; cvTitle: string | null })[]> {
  const signedUpFrom = new Date(now.getTime() - LIFECYCLE_TIMING.reminderSignupWindowMs);
  const editedFrom = new Date(now.getTime() - LIFECYCLE_TIMING.reminderEditWindowMs);
  const editedBy = new Date(now.getTime() - LIFECYCLE_TIMING.reminderAfterEditMs);
  // Their most recently edited CV, if it was last touched a day to a week
  // ago — and no CV of theirs was ever downloaded (a download finalizes it).
  return prisma.$queryRaw<(Recipient & { cvId: string; cvTitle: string | null })[]>`
    SELECT u."id", u."email", u."firstName", u."signupIntent", cv."id" AS "cvId", cv."title" AS "cvTitle"
    FROM "User" u
    JOIN LATERAL (
      SELECT d."id", d."title", d."updatedAt" FROM "CVDocument" d
      WHERE d."userId" = u."id" ORDER BY d."updatedAt" DESC LIMIT 1
    ) cv ON true
    WHERE u."status" = 'ACTIVE' AND u."role" = 'USER'
      AND u."emailVerifiedAt" IS NOT NULL AND u."emailAnnouncementsOptOut" = false
      AND u."createdAt" >= ${signedUpFrom}
      AND cv."updatedAt" >= ${editedFrom} AND cv."updatedAt" <= ${editedBy}
      AND NOT EXISTS (SELECT 1 FROM "CVDocument" f WHERE f."userId" = u."id" AND f."status" = 'final')
      AND NOT EXISTS (SELECT 1 FROM "ProductEvent" e WHERE e."userId" = u."id" AND e."name" = 'pdf_downloaded')
      AND NOT EXISTS (SELECT 1 FROM "LifecycleEmail" l WHERE l."userId" = u."id" AND l."kind" = 'download_reminder')
    ORDER BY u."createdAt" ASC
    LIMIT ${take}`;
}

/** Claims the email for this user: false if it was already claimed (here or on another server). */
async function claim(userId: string, kind: LifecycleKind): Promise<string | null> {
  try {
    const row = await prisma.lifecycleEmail.create({ data: { userId, kind, status: "sending" } });
    return row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

async function deliver(recipient: Recipient, kind: LifecycleKind, email: RenderedEmail): Promise<boolean> {
  const claimId = await claim(recipient.id, kind);
  if (!claimId) return false;
  const result = await sendEmail({
    to: recipient.email,
    userId: recipient.id,
    kind: "lifecycle",
    ...email,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl(recipient.id)}>` },
  });
  await prisma.lifecycleEmail.update({
    where: { id: claimId },
    data: {
      status: result.status,
      error: result.status === "failed" ? result.error.slice(0, 500) : null,
      sentAt: result.status === "sent" ? new Date() : null,
    },
  });
  return true;
}

/** One pass: sends what's due, up to the per-tick cap. Returns how many went out (or were attempted). */
export async function runLifecycleEmails(now: Date = new Date()): Promise<number> {
  if (!(await getSettings()).lifecycleEmails.enabled) return 0;
  // No provider (production without email set up): nothing would arrive, so nothing is claimed.
  if (!getEmailProvider()) return 0;

  let sent = 0;
  const budgetLeft = () => MAX_EMAILS_PER_TICK - sent;

  for (const user of await welcomeCandidates(now, budgetLeft())) {
    if (budgetLeft() <= 0) break;
    const intent = intentOf(user);
    if (await deliver(user, "welcome", welcomeEmail({ firstName: user.firstName, intent, actionUrl: flowLink(intent), unsubscribeUrl: unsubscribeUrl(user.id) }))) {
      sent++;
      await sleep(EMAIL_SEND_INTERVAL_MS);
    }
  }

  if (budgetLeft() > 0) {
    for (const user of await nudgeCandidates(now, budgetLeft())) {
      const intent = intentOf(user);
      if (await deliver(user, "first_cv_nudge", firstCvNudgeEmail({ firstName: user.firstName, actionUrl: flowLink(intent), unsubscribeUrl: unsubscribeUrl(user.id) }))) {
        sent++;
        await sleep(EMAIL_SEND_INTERVAL_MS);
      }
    }
  }

  if (budgetLeft() > 0) {
    for (const user of await reminderCandidates(now, budgetLeft())) {
      const email = downloadReminderEmail({
        firstName: user.firstName,
        cvTitle: user.cvTitle,
        actionUrl: `${env.FRONTEND_URL}/dashboard/editor/${user.cvId}`,
        unsubscribeUrl: unsubscribeUrl(user.id),
      });
      if (await deliver(user, "download_reminder", email)) {
        sent++;
        await sleep(EMAIL_SEND_INTERVAL_MS);
      }
    }
  }

  return sent;
}

let running = false;

/** Starts the background loop (server.ts). One pass at a time per server. */
export function startLifecycleEmails() {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runLifecycleEmails();
    } catch (err) {
      console.error("[lifecycle] run failed", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void run(), FIRST_TICK_DELAY_MS).unref();
  setInterval(() => void run(), TICK_INTERVAL_MS).unref();
}
