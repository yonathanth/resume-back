import { env } from "../../config/env";

// The catalog of things Chapa sells. GoMoxie Pro itself is also sellable via
// Polar (a separate, subscription-native integration — see services/polar/)
// — this catalog exists only for products that go through Chapa's one-time
// checkout+webhook flow. "PRO_SUBSCRIPTION" here means a single 1-month
// Chapa-paid Pro period (see payment.service.ts's grantChapaProPeriod), not
// a recurring subscription — Chapa has no auto-renewal, so each purchase is
// independent and a past SUCCESS must never block a new one (see
// initializePaymentForResource's `reuseExistingSuccess`).
export const PRODUCT_TYPES = ["PRO_SUBSCRIPTION"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export function isProductType(value: string): value is ProductType {
  return (PRODUCT_TYPES as readonly string[]).includes(value);
}

export interface ProductDefinition {
  amount: number;
  currency: string;
  title: string;
}

// The backend is the sole source of truth for price — never trust an amount
// supplied by the frontend.
export function getProductDefinition(productType: ProductType): ProductDefinition {
  switch (productType) {
    case "PRO_SUBSCRIPTION":
      return {
        amount: env.CV_PAYMENT_PRICE,
        currency: env.CV_PAYMENT_CURRENCY,
        // Chapa's v1 `customization.title` caps at 16 characters and only
        // allows letters, numbers, hyphens, underscores, spaces, and dots —
        // no parentheses. Keep this short and plain; it's Chapa-checkout
        // display text only, not shown anywhere else in the app.
        title: "GoMoxie Pro",
      };
  }
}

export class ProductResourceNotFoundError extends Error {
  constructor(productType: ProductType, resourceId: string) {
    super(`${productType} resource not found: ${resourceId}`);
    this.name = "ProductResourceNotFoundError";
  }
}

// Confirms `resourceId` is legitimate for this purchase. PRO_SUBSCRIPTION
// has no separate resource — the purchasing user IS the resource, so
// resourceId must be their own id (always true when called from our own
// checkout-creation code, since resourceId is never client-supplied there).
export async function assertResourceOwnership(
  productType: ProductType,
  resourceId: string,
  userId: string
): Promise<void> {
  switch (productType) {
    case "PRO_SUBSCRIPTION": {
      if (resourceId !== userId) throw new ProductResourceNotFoundError(productType, resourceId);
      return;
    }
  }
}
