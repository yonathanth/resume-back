import { dodo, dodoErrorMessage, DodoNotConfiguredError } from "./client";
import type { DodoSubscriptionSnapshot } from "./subscription-sync.service";
import type { UpdateSubscriptionPlanReq } from "dodopayments/resources/subscriptions";

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
 * never billed for two plans at once, either now or at the next renewal
 * (see planChangeTiming). A
 * scheduled cancellation is lifted first — choosing a new plan means
 * keeping one. Returns the subscription as it is after the change.
 */
export async function changeSubscriptionProduct(
  subscriptionId: string,
  productId: string,
  wasCancelScheduled: boolean,
  timing: PlanChangeTiming
): Promise<DodoSubscriptionSnapshot> {
  try {
    if (wasCancelScheduled) {
      await dodo().subscriptions.update(subscriptionId, { cancel_at_next_billing_date: false });
    }
    await dodo().subscriptions.changePlan(subscriptionId, changeRequest(productId, timing));
    return await dodo().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    throw wrap(err, "Failed to change the Dodo subscription plan");
  }
}

/** When a plan change takes effect: now (an upgrade) or at the next renewal (a downgrade or period change). */
export type PlanChangeTiming = "now" | "renewal";

/**
 * The one rule for plan changes. Moving up to Pro happens now and is charged
 * the prorated difference for the rest of the period; anything else (down to
 * Plus, or the same plan on another period) waits for the renewal: nothing is
 * charged or refunded now, and the new plan's price is the next renewal.
 */
export function planChangeTiming(fromTier: "plus" | "pro", toTier: "plus" | "pro"): PlanChangeTiming {
  return fromTier === "plus" && toTier === "pro" ? "now" : "renewal";
}

const changeRequest = (productId: string, timing: PlanChangeTiming): UpdateSubscriptionPlanReq => ({
    product_id: productId,
    quantity: 1,
    // A newer choice replaces a change that was waiting for the renewal.
    cancel_scheduled_change_plan: true,
    ...(timing === "now"
      ? // Charge the difference now; if that payment fails, they stay on their plan.
        ({ proration_billing_mode: "prorated_immediately", effective_at: "immediately", on_payment_failure: "prevent_change" } as const)
      : // At the renewal the new plan's full price replaces the usual renewal charge.
        ({ proration_billing_mode: "full_immediately", effective_at: "next_billing_date", on_payment_failure: "prevent_change" } as const)),
});

/** What an upgrade charges now, in the smallest currency unit (cents). */
export async function previewUpgradeCharge(subscriptionId: string, productId: string): Promise<{ amount: number; currency: string }> {
  try {
    const preview = await dodo().subscriptions.previewChangePlan(subscriptionId, changeRequest(productId, "now"));
    return { amount: preview.immediate_charge.summary.total_amount, currency: preview.immediate_charge.summary.currency };
  } catch (err) {
    throw wrap(err, "Failed to preview the Dodo plan change");
  }
}

/** The change waiting for the next renewal, if any. */
export async function getScheduledChange(subscriptionId: string): Promise<{ productId: string; effectiveAt: string } | null> {
  try {
    const sub = await dodo().subscriptions.retrieve(subscriptionId);
    const scheduled = sub.scheduled_change;
    return scheduled ? { productId: scheduled.product_id, effectiveAt: scheduled.effective_at } : null;
  } catch (err) {
    throw wrap(err, "Failed to read the Dodo subscription");
  }
}
