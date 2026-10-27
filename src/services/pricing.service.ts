import { getSettings, type Settings } from "./settings.service";
import {
  BILLING_PERIODS,
  ONE_TIME_PRICES,
  PAID_TIERS,
  getOneTimeProduct,
  getSubscriptionPlan,
  type BillingPeriod,
  type PaidTier,
} from "./polar/plans";
import { countLifetimeSold } from "./polar/credit-fulfillment.service";

// The public price list (GET /api/v1/pricing): what the pricing page, the
// upgrade page and every paywall render from, so they always match what the
// backend charges and enforces. Pro's fair-use caps are deliberately left
// out — Pro is presented as unlimited.

export interface LifetimeOfferStatus {
  /** On sale right now (enabled, seats left, not past its end date, product configured). */
  available: boolean;
  /** Shown on the pricing cards (enabled, seats left, not ended), even before it can be bought. */
  listed: boolean;
  /** Its Polar product is set up, so it can be bought. */
  configured: boolean;
  /** Which limit the cards show: "Limited seats available", or a countdown to endsAt. */
  display: "seats" | "countdown";
  endsAt: string | null;
  soldOut: boolean;
  ended: boolean;
}

export async function lifetimeOfferStatus(settings?: Settings): Promise<LifetimeOfferStatus & { seatsLeft: number | null }> {
  const offer = (settings ?? (await getSettings())).plans.lifetimeOffer;
  const sold = offer.seatLimit !== null ? await countLifetimeSold() : 0;
  const seatsLeft = offer.seatLimit !== null ? Math.max(0, offer.seatLimit - sold) : null;
  const soldOut = seatsLeft !== null && seatsLeft <= 0;
  const ended = offer.endsAt !== null && new Date(offer.endsAt).getTime() <= Date.now();
  const configured = Boolean(getOneTimeProduct("plus_lifetime").productId);
  return {
    available: offer.enabled && !soldOut && !ended && configured,
    listed: offer.enabled && !soldOut && !ended,
    configured,
    display: offer.display,
    endsAt: offer.endsAt,
    soldOut,
    ended,
    seatsLeft,
  };
}

export async function getPricingCatalog() {
  const settings = await getSettings();
  const plans = {} as Record<PaidTier, Record<BillingPeriod, { price: number; available: boolean }>>;
  for (const tier of PAID_TIERS) {
    plans[tier] = {} as Record<BillingPeriod, { price: number; available: boolean }>;
    for (const period of BILLING_PERIODS) {
      const plan = getSubscriptionPlan(tier, period);
      plans[tier][period] = { price: plan.price, available: Boolean(plan.productId) };
    }
  }
  const { seatsLeft: _seatsLeft, ...offer } = await lifetimeOfferStatus(settings);
  return {
    currency: "USD",
    free: { generations: settings.plans.free.generations, unpaidCvCap: settings.plans.free.unpaidCvCap },
    plans,
    plusLimits: {
      weekly: settings.plans.plus.weekly,
      monthly: settings.plans.plus.monthly,
      quarterly: settings.plans.plus.quarterly,
    },
    lifetime: { price: ONE_TIME_PRICES.plus_lifetime, limits: settings.plans.plus.lifetime, offer },
    payPerCv: {
      cv_new: { price: ONE_TIME_PRICES.cv_new, available: Boolean(getOneTimeProduct("cv_new").productId) },
      cv_edit: { price: ONE_TIME_PRICES.cv_edit, available: Boolean(getOneTimeProduct("cv_edit").productId) },
    },
  };
}
