import { prisma } from "../../db/client";
import { env } from "../../config/env";
import { sendEmail } from "../email/send";
import { proActivatedEmail, proEndedEmail } from "../email/templates";
import { findSubscriptionByProductId } from "../billing/plans";

/**
 * The fields sync needs from a Dodo subscription — present both on a
 * `subscription.*` webhook's `data` and on the Subscription object Dodo's API
 * returns, so the admin's "re-sync from Dodo" reuses the exact same write.
 */
export interface DodoSubscriptionSnapshot {
  subscription_id: string;
  product_id: string;
  status: string;
  /** The end of the period already paid for. */
  next_billing_date: string;
  cancel_at_next_billing_date: boolean;
  customer: { customer_id: string; email?: string | null };
  metadata?: Record<string, string | number | boolean> | null;
}

/** Dodo statuses that still give the plan's access. */
const ACCESS_STATUSES = new Set(["active"]);
/** Dodo statuses that mean a renewal is still pending or being retried. */
const AT_RISK_STATUSES = new Set(["on_hold", "past_due"]);
/** Dodo statuses after which the subscription is over. */
const ENDED_STATUSES = new Set(["cancelled", "expired", "failed"]);

export function isAccessStatus(status: string | null | undefined): boolean {
  return Boolean(status && ACCESS_STATUSES.has(status));
}

const metadataUserId = (snapshot: DodoSubscriptionSnapshot): string | null => {
  const value = snapshot.metadata?.userId;
  return typeof value === "string" && value ? value : null;
};

/**
 * The gomoxie user a Dodo subscription belongs to: by the Dodo ids we've
 * stored, then by the `userId` our checkout put in the metadata, then by the
 * customer's email (a subscription started some other way, e.g. from the
 * Dodo dashboard).
 */
async function findUserForSubscription(snapshot: DodoSubscriptionSnapshot) {
  const byDodoIds = await prisma.user.findFirst({
    where: { OR: [{ dodoSubscriptionId: snapshot.subscription_id }, { dodoCustomerId: snapshot.customer.customer_id }] },
  });
  if (byDodoIds) return byDodoIds;

  const userId = metadataUserId(snapshot);
  if (userId) {
    const byMetadata = await prisma.user.findUnique({ where: { id: userId } });
    if (byMetadata) return byMetadata;
  }

  const email = snapshot.customer.email;
  if (!email) return null;
  return prisma.user.findUnique({ where: { email } });
}

/**
 * Writes a Dodo subscription snapshot onto the matching User row. Always the
 * full current state, never a per-event diff, so a duplicate delivery, an
 * out-of-order one or an admin re-sync all land on the same result.
 *
 * One exception: a snapshot of an *older* subscription never overwrites a
 * newer one that still gives access (e.g. the old plan's late
 * "subscription.expired" arriving after the user subscribed again).
 *
 * Returns the user id, or null when no user matches.
 */
export async function applySubscriptionSnapshot(snapshot: DodoSubscriptionSnapshot): Promise<string | null> {
  const user = await findUserForSubscription(snapshot);
  if (!user) return null;

  const otherSubscriptionActive =
    user.subscriptionProvider === "DODO" &&
    user.dodoSubscriptionId !== null &&
    user.dodoSubscriptionId !== snapshot.subscription_id &&
    isAccessStatus(user.subscriptionStatus);
  if (otherSubscriptionActive && !isAccessStatus(snapshot.status)) {
    return user.id;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Marks billing as Dodo's — the account-deletion guard and the plan
      // shown to the user both key off this.
      subscriptionProvider: "DODO",
      dodoCustomerId: snapshot.customer.customer_id,
      dodoSubscriptionId: snapshot.subscription_id,
      dodoProductId: snapshot.product_id,
      subscriptionStatus: snapshot.status,
      subscriptionCurrentPeriodEnd: new Date(snapshot.next_billing_date),
      subscriptionCancelAtPeriodEnd: snapshot.cancel_at_next_billing_date,
    },
  });

  // Tell the user when their plan starts or ends. Best effort — never fails the sync.
  const before = user.subscriptionProvider === "DODO" ? (user.subscriptionStatus ?? "") : "";
  const planName = findSubscriptionByProductId(snapshot.product_id)?.tier === "pro" ? "Pro" : "Plus";
  if (isAccessStatus(snapshot.status) && !isAccessStatus(before)) {
    void sendEmail({
      to: user.email,
      userId: user.id,
      kind: "subscription",
      ...proActivatedEmail({ until: null, dashboardUrl: `${env.FRONTEND_URL}/dashboard`, planName }),
    });
  } else if (ENDED_STATUSES.has(snapshot.status) && (isAccessStatus(before) || AT_RISK_STATUSES.has(before))) {
    void sendEmail({
      to: user.email,
      userId: user.id,
      kind: "subscription",
      ...proEndedEmail({ upgradeUrl: `${env.FRONTEND_URL}/dashboard/upgrade`, planName }),
    });
  }

  return user.id;
}
