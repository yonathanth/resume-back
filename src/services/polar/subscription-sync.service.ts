import { webhooks } from "@polar-sh/sdk/2026-10";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import { sendEmail } from "../email/send";
import { proActivatedEmail, proEndedEmail } from "../email/templates";
import { findSubscriptionByProductId } from "./plans";

const { validateEvent } = webhooks;

// The 1.0 prerelease line made validateEvent async and dropped the
// camelCase transform layer — the resolved event's `data` now has the raw
// snake_case field names from the wire payload (e.g. `customer_id`, not
// `customerId`), and timestamp fields are plain ISO strings, not `Date`.
export type PolarWebhookEvent = Awaited<ReturnType<typeof validateEvent>>;

const SUBSCRIPTION_EVENT_TYPES = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.revoked",
  "subscription.past_due",
] as const;

type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];

export type PolarSubscriptionEvent = Extract<PolarWebhookEvent, { type: SubscriptionEventType }>;

/**
 * The fields sync needs — present on both a webhook's `data` and the
 * Subscription object returned by Polar's API, so the admin's "re-sync from
 * Polar" can reuse the exact same write.
 */
export interface PolarSubscriptionSnapshot {
  id: string;
  customer_id: string;
  product_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  customer: { external_id?: string | null; email?: string | null };
}

export function isSubscriptionEvent(event: PolarWebhookEvent): event is PolarSubscriptionEvent {
  return (SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Resolves the GoMoxie user a Polar subscription belongs to. A Polar customer
 * isn't necessarily linked to a User yet on the first event we see for them
 * (there's no checkout flow wired up to set `customer.external_id` to our
 * User.id yet), so this falls back to matching on the customer's email —
 * the same identifier used to initiate Chapa payments (see
 * initializePaymentForResource's `customer.email`).
 */
async function findUserForSubscription(subscription: PolarSubscriptionSnapshot) {
  const byPolarIds = await prisma.user.findFirst({
    where: { OR: [{ polarSubscriptionId: subscription.id }, { polarCustomerId: subscription.customer_id }] },
  });
  if (byPolarIds) return byPolarIds;

  const externalId = subscription.customer.external_id;
  if (externalId) {
    const byExternalId = await prisma.user.findUnique({ where: { id: externalId } });
    if (byExternalId) return byExternalId;
  }

  const email = subscription.customer.email;
  if (!email) return null;

  return prisma.user.findUnique({ where: { email } });
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const ENDED_STATUSES = new Set(["canceled", "revoked", "unpaid", "incomplete_expired"]);

/**
 * Writes a Polar subscription snapshot onto the matching User row. Always
 * writes the full current state rather than diffing per event type — the
 * snapshot already reflects the subscription *after* the change, so
 * replaying an out-of-order or duplicate delivery (or an admin re-sync)
 * converges on the same result. `forcedStatus` is "revoked" for the
 * subscription.revoked event, since Polar's own `status` for a revoked
 * subscription is otherwise indistinguishable from a scheduled cancellation.
 * Returns the user id, or null when no user matches.
 */
export async function applySubscriptionSnapshot(
  subscription: PolarSubscriptionSnapshot,
  forcedStatus?: string
): Promise<string | null> {
  const status = forcedStatus ?? subscription.status;

  const user = await findUserForSubscription(subscription);
  if (!user) {
    return null;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Marks billing as Polar's — the account-deletion guard and the plan
      // shown to the user both key off this.
      subscriptionProvider: "POLAR",
      polarCustomerId: subscription.customer_id,
      polarSubscriptionId: subscription.id,
      polarProductId: subscription.product_id,
      subscriptionStatus: status,
      subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end),
      subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  });

  // Tell the user when Pro starts or ends. Best effort — never fails the sync.
  const before = user.subscriptionStatus ?? "";
  const planName = findSubscriptionByProductId(subscription.product_id)?.tier === "pro" ? "Pro" : "Plus";
  if (status === "active" && before !== "active") {
    void sendEmail({
      to: user.email,
      userId: user.id,
      kind: "subscription",
      ...proActivatedEmail({ until: null, dashboardUrl: `${env.FRONTEND_URL}/dashboard`, planName }),
    });
  } else if (ENDED_STATUSES.has(status) && ACTIVE_STATUSES.has(before)) {
    void sendEmail({ to: user.email, userId: user.id, kind: "subscription", ...proEndedEmail({ upgradeUrl: `${env.FRONTEND_URL}/dashboard/upgrade`, planName }) });
  }

  return user.id;
}

export async function syncSubscriptionFromEvent(event: PolarSubscriptionEvent): Promise<string | null> {
  return applySubscriptionSnapshot(event.data, event.type === "subscription.revoked" ? "revoked" : undefined);
}
