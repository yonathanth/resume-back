import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getPaymentProvider, type PaymentCustomer } from "./payment";
import { assertResourceOwnership, getProductDefinition, type ProductType } from "./payment/products";
import type { Payment } from "@prisma/client";
import { env } from "../config/env";
import { sendEmail } from "./email/send";
import { proActivatedEmail } from "./email/templates";

const AMOUNT_EPSILON = 0.01;

// Chapa can't auto-renew, so a successful PRO_SUBSCRIPTION payment grants a
// fixed 1-month Pro period rather than an ongoing subscription — the user
// simply pays again (via Chapa or Polar) once it lapses. No background job
// is needed to expire it: entitlement.service.ts's hasActiveProAccess
// already compares subscriptionCurrentPeriodEnd to "now" on every check.
const CHAPA_PRO_PERIOD_DAYS = 30;

async function grantChapaProPeriod(userId: string): Promise<void> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionProvider: "CHAPA",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + CHAPA_PRO_PERIOD_DAYS * 24 * 60 * 60 * 1000),
      subscriptionCancelAtPeriodEnd: false,
    },
  });
  // Confirmation email — best effort, never affects the grant.
  void sendEmail({
    to: user.email,
    userId: user.id,
    kind: "subscription",
    ...proActivatedEmail({ until: user.subscriptionCurrentPeriodEnd, dashboardUrl: `${env.FRONTEND_URL}/dashboard`, planName: "Plus" }),
  });
}

export interface InitializePaymentInput {
  productType: ProductType;
  resourceId: string;
  customer: PaymentCustomer;
  /**
   * Whether an existing SUCCESS payment for this exact (userId, productType,
   * resourceId) should short-circuit as "already paid" instead of starting
   * a new checkout. Defaults to true, which is correct for a one-time
   * unlock. PRO_SUBSCRIPTION purchases must pass `false` — Chapa has no
   * renewal, so a past success must never block buying the next period.
   */
  reuseExistingSuccess?: boolean;
}

export interface InitializePaymentResult {
  paymentId: string;
  checkoutUrl: string | null;
  alreadyPaid: boolean;
}

/**
 * Initializes a payment for one specific resource. Reuses an already-SUCCESS
 * payment (no need to pay twice) or an existing still-open PENDING checkout
 * link (avoids creating duplicate Chapa transactions if the user retries
 * before finishing the first one) before creating a new one.
 */
export async function initializePaymentForResource(
  userId: string,
  input: InitializePaymentInput
): Promise<InitializePaymentResult> {
  await assertResourceOwnership(input.productType, input.resourceId, userId);

  if (input.reuseExistingSuccess ?? true) {
    const existingSuccess = await prisma.payment.findFirst({
      where: { userId, productType: input.productType, resourceId: input.resourceId, status: "SUCCESS" },
    });
    if (existingSuccess) {
      return { paymentId: existingSuccess.id, checkoutUrl: null, alreadyPaid: true };
    }
  }

  const existingPending = await prisma.payment.findFirst({
    where: { userId, productType: input.productType, resourceId: input.resourceId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (existingPending?.checkoutUrl) {
    return { paymentId: existingPending.id, checkoutUrl: existingPending.checkoutUrl, alreadyPaid: false };
  }

  const { amount, currency, title } = getProductDefinition(input.productType);
  const merchantReference = `pay_${randomUUID()}`;

  const payment = await prisma.payment.create({
    data: {
      userId,
      productType: input.productType,
      resourceId: input.resourceId,
      provider: "CHAPA",
      merchantReference,
      amount,
      currency,
      status: "PENDING",
    },
  });

  try {
    const result = await getPaymentProvider().initialize({
      amount,
      currency,
      merchantReference,
      customer: input.customer,
      meta: { paymentId: payment.id, productType: input.productType, resourceId: input.resourceId, title },
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutUrl: result.checkoutUrl, providerReference: result.providerReference ?? undefined },
    });

    return { paymentId: payment.id, checkoutUrl: result.checkoutUrl, alreadyPaid: false };
  } catch (err) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } }).catch(() => {});
    throw err;
  }
}

/**
 * Re-checks a payment's status directly with the provider and persists any
 * change. Idempotent: a payment already SUCCESS is returned as-is without a
 * network call, so repeated webhooks/return visits/status polls never
 * re-process a completed payment or grant duplicate fulfillment. Fulfillment
 * (beyond flipping this status flag) is guarded on the PENDING→SUCCESS
 * transition specifically, not on every call — see grantChapaProPeriod for
 * PRO_SUBSCRIPTION's fulfillment.
 */
export async function verifyAndSyncPayment(payment: Payment): Promise<Payment> {
  if (payment.status === "SUCCESS" || payment.status === "FAILED" || payment.status === "CANCELLED") {
    return payment;
  }

  if (!payment.providerReference) {
    return payment;
  }

  const result = await getPaymentProvider().verify(payment.providerReference);

  const matches =
    result.merchantReference === payment.merchantReference &&
    Math.abs(result.amount - payment.amount) < AMOUNT_EPSILON &&
    result.currency === payment.currency;

  let nextStatus = payment.status;
  if (result.status === "success" && matches) {
    nextStatus = "SUCCESS";
  } else if (result.status === "failed") {
    nextStatus = "FAILED";
  }

  if (nextStatus === payment.status) {
    return payment;
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: nextStatus, providerReference: result.providerReference },
  });

  if (nextStatus === "SUCCESS" && payment.productType === "PRO_SUBSCRIPTION") {
    await grantChapaProPeriod(payment.userId);
  }

  return updated;
}
