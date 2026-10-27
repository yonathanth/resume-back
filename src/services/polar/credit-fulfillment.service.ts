import { prisma } from "../../db/client";
import { findOneTimeProductByProductId, isCvUnlockProduct, type OneTimeProduct } from "./plans";
import type { PolarWebhookEvent } from "./subscription-sync.service";

export type PolarOrderPaidEvent = Extract<PolarWebhookEvent, { type: "order.paid" }>;

export function isOrderPaidEvent(event: PolarWebhookEvent): event is PolarOrderPaidEvent {
  return event.type === "order.paid";
}

/**
 * The fields needed from a Polar `order.paid` webhook's `data` (an `Order`)
 * to fulfill a one-time purchase — a strict subset, so the full SDK `Order`
 * type satisfies this structurally with no mapping needed. `metadata` is
 * copied by Polar from the checkout (see checkout.service.ts).
 */
export interface PolarOrderSnapshot {
  id: string;
  customer_id: string;
  product_id: string | null;
  /** Non-null means this is a subscription's recurring invoice, not a one-time purchase — must be ignored here. */
  subscription_id: string | null;
  metadata?: Record<string, unknown> | null;
  customer: { external_id?: string | null; email?: string | null };
}

// Mirrors subscription-sync.service.ts's findUserForSubscription — same
// precedence (Polar ids, then external_id as our User.id, then email).
async function findUserForOrder(order: PolarOrderSnapshot) {
  const byCustomerId = await prisma.user.findFirst({ where: { polarCustomerId: order.customer_id } });
  if (byCustomerId) return byCustomerId;

  const externalId = order.customer.external_id;
  if (externalId) {
    const byExternalId = await prisma.user.findUnique({ where: { id: externalId } });
    if (byExternalId) return byExternalId;
  }

  const email = order.customer.email;
  if (!email) return null;

  return prisma.user.findUnique({ where: { email } });
}

const metadataString = (order: PolarOrderSnapshot, key: string): string | null => {
  const value = order.metadata?.[key];
  return typeof value === "string" && value ? value : null;
};

/**
 * Fulfills a one-time purchase:
 *   plus_lifetime  → a LIFETIME_PLUS grant (Plus forever, limits reset monthly).
 *   cv_new/cv_edit → unlocks the CV named in the checkout's metadata.
 * Returns the user id, or null (no-op) for a subscription's recurring invoice,
 * an unknown product, or when no GoMoxie user (or CV) matches.
 *
 * Idempotent per Polar order, not just per webhook delivery: Polar may
 * deliver more than one event for the same order, each with its own
 * "webhook-id" — so the lifetime grant records the order id (in `note`) and
 * is never created twice, and unlocking a CV twice changes nothing.
 */
export async function grantCreditFromOrder(order: PolarOrderSnapshot): Promise<string | null> {
  if (order.subscription_id) return null;

  // Only what the order actually paid for counts, never what its metadata claims.
  const product: OneTimeProduct | null = findOneTimeProductByProductId(order.product_id)?.product ?? null;
  if (!product) return null;

  const user = await findUserForOrder(order);
  if (!user) return null;

  if (product === "plus_lifetime") {
    const alreadyGranted = await prisma.entitlement.findFirst({
      where: { userId: user.id, kind: "LIFETIME_PLUS", note: order.id },
    });
    if (alreadyGranted) return user.id;
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        kind: "LIFETIME_PLUS",
        amount: null,
        reason: "Purchased GoMoxie Plus Lifetime via Polar",
        note: order.id,
        startsAt: new Date(),
        expiresAt: null,
      },
    });
    return user.id;
  }

  if (isCvUnlockProduct(product)) {
    const cvDocumentId = metadataString(order, "cvDocumentId");
    if (!cvDocumentId) return null;
    const { count } = await prisma.cVDocument.updateMany({
      where: { id: cvDocumentId, userId: user.id, unlockedAt: null },
      data: { unlockedAt: new Date() },
    });
    if (count === 0) {
      // Already unlocked (a repeat delivery) still counts as handled.
      const exists = await prisma.cVDocument.findFirst({ where: { id: cvDocumentId, userId: user.id }, select: { id: true } });
      if (!exists) return null;
    }
    return user.id;
  }

  return null;
}

/** Plus Lifetime deals sold so far (admin grants included), for the seat limit. */
export function countLifetimeSold(): Promise<number> {
  return prisma.entitlement.count({ where: { kind: "LIFETIME_PLUS", revokedAt: null } });
}
