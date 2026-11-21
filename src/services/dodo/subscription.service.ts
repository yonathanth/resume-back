import { dodo, dodoErrorMessage, DodoNotConfiguredError } from "./client";
import type { DodoSubscriptionSnapshot } from "./subscription-sync.service";

export class DodoSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DodoSubscriptionError";
  }
}

function wrap(err: unknown, fallback: string): Error {
  if (err instanceof DodoNotConfiguredError) return err;
  return new DodoSubscriptionError(dodoErrorMessage(err, fallback));
}

/** Dodo's current copy of a subscription, as a sync snapshot. */
export async function getSubscription(subscriptionId: string): Promise<DodoSubscriptionSnapshot> {
  try {
    return await dodo().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    throw wrap(err, "Failed to read the Dodo subscription");
  }
}

async function setCancelAtNextBillingDate(subscriptionId: string, cancel: boolean): Promise<DodoSubscriptionSnapshot> {
  try {
    return await dodo().subscriptions.update(subscriptionId, {
      cancel_at_next_billing_date: cancel,
      ...(cancel ? { cancel_reason: "cancelled_by_customer" as const } : {}),
    });
  } catch (err) {
    throw wrap(err, cancel ? "Failed to cancel the Dodo subscription" : "Failed to resume the Dodo subscription");
  }
}

/**
 * Schedules cancellation for the end of the period already paid for — never
 * an immediate stop. The plan stays active until the next billing date; Dodo
 * just won't charge again. Refunds are a separate step (see /refunds and the
 * refund webhook).
 */
export function cancelSubscriptionAtPeriodEnd(subscriptionId: string) {
  return setCancelAtNextBillingDate(subscriptionId, true);
}

/** Undoes a scheduled cancellation, so the subscription renews as normal. */
export function resumeSubscription(subscriptionId: string) {
  return setCancelAtNextBillingDate(subscriptionId, false);
}

/**
 * Ends a subscription right away — used when its payment is refunded, so a
 * refunded plan neither keeps its access nor renews.
 */
export async function cancelSubscriptionNow(subscriptionId: string): Promise<DodoSubscriptionSnapshot> {
  try {
    return await dodo().subscriptions.update(subscriptionId, { status: "cancelled", cancel_reason: "cancelled_by_merchant" });
  } catch (err) {
    throw wrap(err, "Failed to end the Dodo subscription");
  }
}

/**
 * Moves the subscription to another plan's product in place, so the user is
 * never billed for two plans at once. "prorated_immediately" charges (or
 * credits) the difference for the rest of the current period now. A
 * scheduled cancellation is lifted first — choosing a new plan means
 * keeping one. Returns the subscription as it is after the change.
 */
export async function changeSubscriptionProduct(
  subscriptionId: string,
  productId: string,
  wasCancelScheduled: boolean
): Promise<DodoSubscriptionSnapshot> {
  try {
    if (wasCancelScheduled) {
      await dodo().subscriptions.update(subscriptionId, { cancel_at_next_billing_date: false });
    }
    await dodo().subscriptions.changePlan(subscriptionId, {
      product_id: productId,
      quantity: 1,
      proration_billing_mode: "prorated_immediately",
    });
    return await dodo().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    throw wrap(err, "Failed to change the Dodo subscription plan");
  }
}
