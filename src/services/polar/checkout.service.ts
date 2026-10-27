import { polarClient } from "./client";
import { env } from "../../config/env";

export class PolarCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarCheckoutError";
  }
}

export interface CreateProCheckoutInput {
  userId: string;
  email: string;
  /** Which Polar product to check out — a subscription tier or a one-time credit (see services/polar/plans.ts). */
  productId: string;
  /** Echoed back onto the resulting Order/Subscription — lets the webhook
   * identify a one-time purchase without depending solely on product id
   * matching (see credit-fulfillment.service.ts). */
  metadata?: Record<string, string>;
}

/**
 * Creates a Polar checkout session for one product — a recurring Pro tier
 * (weekly/monthly/quarterly) or a one-time pay-per-use credit.
 * `external_customer_id` is set to our own User.id — Polar carries this onto
 * the resulting Customer, so subscription-sync.service.ts's
 * findUserForSubscription (and credit-fulfillment.service.ts's equivalent
 * for one-time orders) resolves the webhook events on the very first
 * delivery (it already knows to look up a User by treating a
 * `customer.external_id` as a User.id) without needing any changes there.
 *
 * Field names are snake_case (`external_customer_id`, not
 * `externalCustomerId`) — the 1.0 prerelease line of the SDK dropped the
 * camelCase inbound/outbound transform the old SDK applied, so request/
 * response shapes now match the wire format (and Polar's API docs) directly.
 */
export async function createProCheckoutUrl(input: CreateProCheckoutInput): Promise<string> {
  try {
    const checkout = await polarClient.checkouts.create({
      products: [input.productId],
      external_customer_id: input.userId,
      customer_email: input.email,
      success_url: `${env.POLAR_CHECKOUT_RETURN_URL}?checkout_id={CHECKOUT_ID}`,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return checkout.url;
  } catch (err) {
    throw new PolarCheckoutError(err instanceof Error ? err.message : "Failed to create Polar checkout session");
  }
}
