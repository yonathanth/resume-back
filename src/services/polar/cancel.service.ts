import { polarClient } from "./client";

export class PolarCancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarCancelError";
  }
}

export interface CancelledSubscriptionSnapshot {
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

async function setCancelAtPeriodEnd(
  polarSubscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<CancelledSubscriptionSnapshot> {
  try {
    const updated = await polarClient.subscriptions.update(polarSubscriptionId, {
      cancel_at_period_end: cancelAtPeriodEnd,
    });
    return {
      status: updated.status,
      currentPeriodEnd: updated.current_period_end,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
    };
  } catch (err) {
    throw new PolarCancelError(err instanceof Error ? err.message : "Failed to update Polar subscription");
  }
}

/**
 * Schedules cancellation at the end of the current billing period — never an
 * immediate revoke. The subscription stays active (and the user keeps Pro
 * access) until `currentPeriodEnd`; Polar simply won't charge/renew it after
 * that. Nothing already paid is refunded.
 */
export function cancelProSubscriptionAtPeriodEnd(polarSubscriptionId: string) {
  return setCancelAtPeriodEnd(polarSubscriptionId, true);
}

/**
 * Reverses a pending cancel-at-period-end — the subscription goes back to
 * renewing normally. Only meaningful while the subscription is still active
 * (i.e. before `currentPeriodEnd` actually passes).
 */
export function resumeProSubscription(polarSubscriptionId: string) {
  return setCancelAtPeriodEnd(polarSubscriptionId, false);
}

/**
 * Moves the subscription to another plan's product, in place: the old plan
 * stops and the new one takes over on the same subscription, so the user is
 * never billed for two plans at once. "prorate" credits the unused part of
 * the old plan against the new one on the next invoice. A cancellation that
 * was scheduled is lifted first — choosing a new plan means keeping Pro.
 * Returns the updated subscription (snapshot-shaped, see subscription-sync).
 */
export async function changeProSubscriptionProduct(polarSubscriptionId: string, productId: string, wasCancelScheduled: boolean) {
  try {
    if (wasCancelScheduled) {
      await polarClient.subscriptions.update(polarSubscriptionId, { cancel_at_period_end: false });
    }
    return await polarClient.subscriptions.update(polarSubscriptionId, {
      product_id: productId,
      proration_behavior: "prorate",
    });
  } catch (err) {
    throw new PolarCancelError(err instanceof Error ? err.message : "Failed to change Polar subscription plan");
  }
}
