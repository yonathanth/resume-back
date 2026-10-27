import { env } from "../../config/env";
import type { FlowKey } from "../settings.service";

// What GoMoxie sells. Prices live in Polar (each plan + billing period is its
// own Polar product); the copies here are only for display, and must match.
//
//   Free — one free AI CV (any kind), then pay per CV at download.
//   Plus — monthly-style limits per billing period (admin-editable, see the
//          "plans" setting), career profiles. Also sold as a one-time
//          Lifetime deal with limits that reset every month.
//   Pro  — "unlimited" (a fair-use cap per period that the UI never shows,
//          only the Terms mention), career profiles.

export const PAID_TIERS = ["plus", "pro"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];
export type PlanTier = "free" | PaidTier;

export const BILLING_PERIODS = ["weekly", "monthly", "quarterly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Free < Plus < Pro — a CV locked on one plan is unlocked by a higher one. */
export const TIER_RANK: Record<PlanTier, number> = { free: 0, plus: 1, pro: 2 };

export function isPlanTier(value: string | null | undefined): value is PlanTier {
  return value === "free" || value === "plus" || value === "pro";
}

export const SUBSCRIPTION_PRICES: Record<PaidTier, Record<BillingPeriod, number>> = {
  plus: { weekly: 3.99, monthly: 7.99, quarterly: 19.99 },
  pro: { weekly: 6.99, monthly: 14.99, quarterly: 34.99 },
};

const PERIOD_LABEL: Record<BillingPeriod, string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "3 Months" };
const TIER_LABEL: Record<PaidTier, string> = { plus: "Plus", pro: "Pro" };

export interface SubscriptionPlanDefinition {
  tier: PaidTier;
  period: BillingPeriod;
  /** undefined until the real Polar product id is filled into .env. */
  productId: string | undefined;
  label: string;
  price: number;
}

function subscriptionProductId(tier: PaidTier, period: BillingPeriod): string | undefined {
  const ids: Record<PaidTier, Record<BillingPeriod, string | undefined>> = {
    plus: {
      weekly: env.POLAR_PRODUCT_PLUS_WEEKLY_ID,
      monthly: env.POLAR_PRODUCT_PLUS_MONTHLY_ID,
      quarterly: env.POLAR_PRODUCT_PLUS_QUARTERLY_ID,
    },
    pro: {
      weekly: env.POLAR_PRODUCT_PRO_WEEKLY_ID,
      monthly: env.POLAR_PRODUCT_PRO_MONTHLY_ID,
      quarterly: env.POLAR_PRODUCT_PRO_QUARTERLY_ID,
    },
  };
  return ids[tier][period] || undefined;
}

export function getSubscriptionPlan(tier: PaidTier, period: BillingPeriod): SubscriptionPlanDefinition {
  return {
    tier,
    period,
    productId: subscriptionProductId(tier, period),
    label: `GoMoxie ${TIER_LABEL[tier]} ${PERIOD_LABEL[period]}`,
    price: SUBSCRIPTION_PRICES[tier][period],
  };
}

/** The retired single-plan products — their subscribers are on Plus now. */
function legacyPeriod(productId: string): BillingPeriod | null {
  if (productId === env.POLAR_PRODUCT_WEEKLY_ID) return "weekly";
  if (productId === env.POLAR_PRODUCT_MONTHLY_ID) return "monthly";
  if (productId === env.POLAR_PRODUCT_QUARTERLY_ID) return "quarterly";
  return null;
}

/**
 * Which plan a stored User.polarProductId is. Null when unset or unknown —
 * an unknown paid product is treated as Plus Monthly by the caller.
 */
export function findSubscriptionByProductId(
  productId: string | null | undefined
): { tier: PaidTier; period: BillingPeriod; legacy: boolean } | null {
  if (!productId) return null;
  for (const tier of PAID_TIERS) {
    for (const period of BILLING_PERIODS) {
      if (subscriptionProductId(tier, period) === productId) return { tier, period, legacy: false };
    }
  }
  const legacy = legacyPeriod(productId);
  return legacy ? { tier: "plus", period: legacy, legacy: true } : null;
}

// One-time (non-recurring) products.
//   plus_lifetime — Plus forever, limits reset monthly (a LIFETIME_PLUS grant).
//   cv_new        — unlocks downloading one new CV.
//   cv_edit       — unlocks downloading one tailored or improved CV.
export const ONE_TIME_PRODUCTS = ["plus_lifetime", "cv_new", "cv_edit"] as const;
export type OneTimeProduct = (typeof ONE_TIME_PRODUCTS)[number];
export const CV_UNLOCK_PRODUCTS = ["cv_new", "cv_edit"] as const;
export type CvUnlockProduct = (typeof CV_UNLOCK_PRODUCTS)[number];

export function isCvUnlockProduct(value: string | null | undefined): value is CvUnlockProduct {
  return value === "cv_new" || value === "cv_edit";
}

/** What unlocking a CV made in this flow costs: a new CV, or a tailored / improved one. */
export function unlockProductFor(flow: FlowKey, fromExisting: boolean): CvUnlockProduct {
  return flow === "create" || !fromExisting ? "cv_new" : "cv_edit";
}

export const ONE_TIME_PRICES: Record<OneTimeProduct, number> = {
  plus_lifetime: 79,
  cv_new: 2.99,
  cv_edit: 1.99,
};

export interface OneTimeProductDefinition {
  product: OneTimeProduct;
  productId: string | undefined;
  label: string;
  price: number;
}

const ONE_TIME_LABEL: Record<OneTimeProduct, string> = {
  plus_lifetime: "GoMoxie Plus Lifetime",
  cv_new: "Download one new CV",
  cv_edit: "Download one tailored or improved CV",
};

function oneTimeProductId(product: OneTimeProduct): string | undefined {
  const id =
    product === "plus_lifetime"
      ? env.POLAR_PRODUCT_PLUS_LIFETIME_ID
      : product === "cv_new"
        ? env.POLAR_PRODUCT_CV_NEW_ID
        : env.POLAR_PRODUCT_CV_EDIT_ID;
  return id || undefined;
}

export function getOneTimeProduct(product: OneTimeProduct): OneTimeProductDefinition {
  return { product, productId: oneTimeProductId(product), label: ONE_TIME_LABEL[product], price: ONE_TIME_PRICES[product] };
}

export function findOneTimeProductByProductId(productId: string | null | undefined): OneTimeProductDefinition | null {
  if (!productId) return null;
  const product = ONE_TIME_PRODUCTS.find((p) => oneTimeProductId(p) === productId);
  return product ? getOneTimeProduct(product) : null;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}
