import type { User } from "@prisma/client";
import { dodo, dodoErrorMessage, DodoNotConfiguredError } from "./client";
import { env } from "../../config/env";

export class DodoCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DodoCheckoutError";
  }
}

export interface CreateCheckoutInput {
  user: Pick<User, "id" | "email" | "fullName" | "dodoCustomerId">;
  /** Which Dodo product to check out — a subscription plan or a one-time product (see services/billing/plans.ts). */
  productId: string;
  /** Copied by Dodo onto the resulting payment / subscription, so the webhook can tell what it was for. */
  metadata?: Record<string, string>;
}

/**
 * Creates a Dodo checkout session for one product — a Plus / Pro plan or a
 * one-time purchase — and returns the hosted checkout URL.
 *
 * Our User.id always goes into `metadata.userId`: Dodo copies checkout
 * metadata onto the payment and the subscription, so the webhook finds the
 * user on the very first delivery (see subscription-sync.service.ts). A
 * returning customer is attached by their Dodo customer id, so their
 * subscriptions and payments stay on one Dodo customer.
 */
export async function createCheckoutUrl(input: CreateCheckoutInput): Promise<string> {
  const { user } = input;
  try {
    const session = await dodo().checkoutSessions.create({
      product_cart: [{ product_id: input.productId, quantity: 1 }],
      customer: user.dodoCustomerId
        ? { customer_id: user.dodoCustomerId }
        : { email: user.email, ...(user.fullName ? { name: user.fullName } : {}) },
      return_url: env.DODO_CHECKOUT_RETURN_URL,
      metadata: { ...input.metadata, userId: user.id },
    });
    if (!session.checkout_url) throw new Error("Dodo returned no checkout URL");
    return session.checkout_url;
  } catch (err) {
    if (err instanceof DodoNotConfiguredError) throw err;
    throw new DodoCheckoutError(dodoErrorMessage(err, "Failed to create the Dodo checkout session"));
  }
}
