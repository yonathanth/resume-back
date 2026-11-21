import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { findOneTimeProductByProductId, isCvUnlockProduct, isPlanTier, type OneTimeProduct } from "../billing/plans";
import { releasePayLaterStart } from "../entitlement.service";
import { dodo, dodoErrorMessage } from "./client";
import { cancelSubscriptionNow } from "./subscription.service";
import { applySubscriptionSnapshot } from "./subscription-sync.service";

/**
 * The fields needed from a Dodo payment — a strict subset of both the
 * `payment.succeeded` webhook's `data` and the API's Payment, so either
 * satisfies it with no mapping. `metadata` is copied by Dodo from the
 * checkout (see checkout.service.ts).
 */
export interface DodoPaymentSnapshot {
  payment_id: string;
  /** Set when this payment belongs to a subscription — handled by the subscription events, not here. */
  subscription_id?: string | null;
  product_cart?: Array<{ product_id: string }> | null;
  metadata?: Record<string, string | number | boolean> | null;
  customer: { customer_id: string; email?: string | null };
}

const metadataString = (payment: DodoPaymentSnapshot, key: string): string | null => {
  const value = payment.metadata?.[key];
  return typeof value === "string" && value ? value : null;
};

/** The one-time product a payment paid for — what was actually bought, never what its metadata claims. */
function oneTimeProductOf(payment: DodoPaymentSnapshot): OneTimeProduct | null {
  for (const item of payment.product_cart ?? []) {
    const found = findOneTimeProductByProductId(item.product_id);
    if (found) return found.product;
  }
  return null;
}

// Same precedence as subscription-sync's lookup: stored Dodo customer id,
// then the userId our checkout put in the metadata, then email.
async function findUserForPayment(payment: DodoPaymentSnapshot) {
  const byCustomerId = await prisma.user.findFirst({ where: { dodoCustomerId: payment.customer.customer_id } });
  if (byCustomerId) return byCustomerId;

  const userId = metadataString(payment, "userId");
  if (userId) {
    const byMetadata = await prisma.user.findUnique({ where: { id: userId } });
    if (byMetadata) return byMetadata;
  }

  const email = payment.customer.email;
  if (!email) return null;
  return prisma.user.findUnique({ where: { email } });
}

/** Remembers the Dodo customer, so the user's next checkout attaches to it. Best effort. */
async function rememberCustomer(userId: string, customerId: string) {
  try {
    await prisma.user.updateMany({ where: { id: userId, dodoCustomerId: null }, data: { dodoCustomerId: customerId } });
  } catch (err) {
    // Another account already holds this Dodo customer id: leave both as they are.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
}

/**
 * Fulfills a one-time purchase off `payment.succeeded`:
 *   plus_lifetime  → a LIFETIME_PLUS grant (Plus forever, limits reset monthly).
 *   cv_new/cv_edit → unlocks the CV named in the checkout's metadata.
 * Returns the user id, or null (no-op) for a subscription payment, an
 * unknown product, or when no gomoxie user (or CV) matches.
 *
 * Idempotent per Dodo payment, not just per webhook delivery: the lifetime
 * grant records the payment id (in `note`) and is never created twice, and
 * unlocking a CV twice changes nothing.
 */
export async function fulfillOneTimePayment(payment: DodoPaymentSnapshot): Promise<string | null> {
  if (payment.subscription_id) return null;

  const product = oneTimeProductOf(payment);
  if (!product) return null;

  const user = await findUserForPayment(payment);
  if (!user) return null;
  await rememberCustomer(user.id, payment.customer.customer_id);

  if (product === "plus_lifetime") {
    const alreadyGranted = await prisma.entitlement.findFirst({
      where: { userId: user.id, kind: "LIFETIME_PLUS", note: payment.payment_id },
    });
    if (alreadyGranted) return user.id;
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        kind: "LIFETIME_PLUS",
        amount: null,
        reason: "Purchased gomoxie Plus Lifetime via Dodo Payments",
        note: payment.payment_id,
        startsAt: new Date(),
        expiresAt: null,
      },
    });
    return user.id;
  }

  if (isCvUnlockProduct(product)) {
    const cvDocumentId = metadataString(payment, "cvDocumentId");
    if (!cvDocumentId) return null;
    const { count } = await prisma.cVDocument.updateMany({
      where: { id: cvDocumentId, userId: user.id, unlockedAt: null },
      data: { unlockedAt: new Date() },
    });
    if (count > 0) {
      // Paid for: its pay-later start stops holding a slot of the unpaid cap.
      const doc = await prisma.cVDocument.findFirst({ where: { id: cvDocumentId }, select: { lockedTier: true } });
      await releasePayLaterStart(user.id, isPlanTier(doc?.lockedTier) ? doc.lockedTier : null);
      return user.id;
    }
    // Already unlocked (a repeat delivery) still counts as handled.
    const exists = await prisma.cVDocument.findFirst({ where: { id: cvDocumentId, userId: user.id }, select: { id: true } });
    return exists ? user.id : null;
  }

  return null;
}

/** Plus Lifetime deals sold so far (admin grants included), for the seat limit. */
export function countLifetimeSold(): Promise<number> {
  return prisma.entitlement.count({ where: { kind: "LIFETIME_PLUS", revokedAt: null } });
}

export interface DodoRefundSnapshot {
  refund_id: string;
  payment_id: string;
  is_partial: boolean;
}

export type RefundOutcome =
  | { status: "processed"; userId: string; action: string }
  | { status: "ignored"; reason: string }
  | { status: "unmatched"; reason: string };

/**
 * Takes back what a fully refunded payment gave (see the Refund and
 * Cancellation Policy): a subscription payment ends that subscription now, a
 * Plus Lifetime grant is revoked, a CV unlock is locked again. A partial
 * refund (a goodwill credit) leaves access as it is. Safe to repeat.
 */
export async function reverseRefundedPayment(refund: DodoRefundSnapshot): Promise<RefundOutcome> {
  if (refund.is_partial) return { status: "ignored", reason: "Partial refund — access is left as it is" };

  let payment: DodoPaymentSnapshot;
  try {
    payment = await dodo().payments.retrieve(refund.payment_id);
  } catch (err) {
    throw new Error(`Couldn't read the refunded payment ${refund.payment_id}: ${dodoErrorMessage(err, "Dodo request failed")}`);
  }

  if (payment.subscription_id) {
    const ended = await cancelSubscriptionNow(payment.subscription_id);
    const userId = await applySubscriptionSnapshot(ended);
    return userId
      ? { status: "processed", userId, action: `Ended subscription ${payment.subscription_id}` }
      : { status: "unmatched", reason: "Subscription ended in Dodo, but no gomoxie user matches it" };
  }

  const product = oneTimeProductOf(payment);
  const user = await findUserForPayment(payment);
  if (!user) return { status: "unmatched", reason: "No gomoxie user matches the refunded payment" };

  if (product === "plus_lifetime") {
    await prisma.entitlement.updateMany({
      where: { userId: user.id, kind: "LIFETIME_PLUS", note: payment.payment_id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: `Refunded (Dodo refund ${refund.refund_id})` },
    });
    return { status: "processed", userId: user.id, action: "Revoked Plus Lifetime" };
  }

  if (isCvUnlockProduct(product)) {
    const cvDocumentId = metadataString(payment, "cvDocumentId");
    if (cvDocumentId) {
      await prisma.cVDocument.updateMany({ where: { id: cvDocumentId, userId: user.id }, data: { unlockedAt: null } });
    }
    return { status: "processed", userId: user.id, action: cvDocumentId ? `Locked CV ${cvDocumentId} again` : "No CV on the payment" };
  }

  return { status: "ignored", reason: "The refunded payment isn't a gomoxie product" };
}
