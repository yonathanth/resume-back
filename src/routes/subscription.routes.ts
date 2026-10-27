import type { FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { changePlanSchema, checkoutSchema } from "../schemas/subscription.schema";
import { applySubscriptionSnapshot } from "../services/polar/subscription-sync.service";
import { createProCheckoutUrl, PolarCheckoutError } from "../services/polar/checkout.service";
import { getSubscriptionPlan } from "../services/polar/plans";
import {
  cancelProSubscriptionAtPeriodEnd,
  changeProSubscriptionProduct,
  resumeProSubscription,
  PolarCancelError,
} from "../services/polar/cancel.service";
import { initializePaymentForResource } from "../services/payment.service";
import { PaymentProviderError } from "../services/payment";
import { countUnpaidCvs, hasActiveProAccess, toEntitlementSnapshot } from "../services/entitlement.service";
import { getSettings } from "../services/settings.service";
import { resolveAccess } from "../services/access.service";

// Effective access (billing + admin grants + plan settings — see
// access.service.ts). isPro is true for a granted Pro period too;
// proSource tells the two apart, and the billing fields below only ever
// describe the real subscription.
async function toStatusResponse(user: User) {
  const access = await resolveAccess(user.id);
  if (!access) throw new Error("User disappeared while reading subscription status");
  const entitlement = toEntitlementSnapshot(access);
  const [settings, unpaidCvs] = await Promise.all([getSettings(), countUnpaidCvs(user.id, access.tier)]);
  // Pro's fair-use cap is enforced but never shown: Pro reads as unlimited.
  const shown = (limit: (typeof access.limits)["create"]) =>
    limit.hidden ? { limit: null, used: limit.used, remaining: null } : { limit: limit.limit, used: limit.used, remaining: limit.remaining };
  return {
    /** "free" | "plus" | "pro" */
    tier: access.tier,
    /** Plus or Pro. */
    isPaid: access.isPaid,
    /** Pro only. */
    isPro: entitlement.isPro,
    freeCreateUsed: entitlement.freeCreateUsed,
    freeTailorUsed: entitlement.freeTailorUsed,
    freeImproveUsed: entitlement.freeImproveUsed,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionProvider: user.subscriptionProvider,
    // The plan's billing period ("weekly" | "monthly" | "quarterly" |
    // "lifetime"), what gives it, and when its limits reset.
    plan: access.plan.period,
    planSource: access.plan.source,
    legacyPlan: access.plan.legacy,
    periodEndsAt: access.plan.periodEndsAt,
    hasLifetime: access.hasLifetime,
    currentPeriodEnd: user.subscriptionCurrentPeriodEnd,
    cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd,
    // Had a paid subscription before but has no paid plan now — the frontend
    // shows "your plan expired, renew" instead of a first-time upgrade pitch.
    isExpired: !access.isPaid && user.subscriptionProvider !== null,
    proSource: access.proSource,
    proGrantExpiresAt: access.proGrantExpiresAt,
    features: access.features,
    // What each flow may still do on this plan (on Free, each is the shared free pool).
    freeUses: {
      create: shown(access.limits.create),
      tailor: shown(access.limits.tailor),
      improve: shown(access.limits.improve),
    },
    free: access.free,
    // Pay-per-CV: AI CVs still waiting to be paid for, and how many may wait at once.
    unpaidCvs: { count: unpaidCvs, cap: settings.plans.free.unpaidCvCap },
  };
}

export async function subscriptionRoutes(app: FastifyInstance) {
  // Starts a checkout with whichever provider the user picked. Polar is a
  // real recurring subscription; Chapa (the local-market alternative, since
  // it can't auto-renew) sells a fixed 1-month Pro period per payment — see
  // payment.service.ts's grantChapaProPeriod, applied once the payment is
  // confirmed (webhook or the Chapa return page's re-verify call), not here.
  app.post("/api/v1/subscriptions/checkout", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    if (parsed.data.provider === "chapa") {
      try {
        const result = await initializePaymentForResource(user.id, {
          productType: "PRO_SUBSCRIPTION",
          resourceId: user.id,
          customer: {
            email: user.email,
            firstName: user.fullName?.split(" ")[0],
            lastName: user.fullName?.split(" ").slice(1).join(" ") || undefined,
          },
          // Chapa never auto-renews — a SUCCESS payment from a past (now
          // possibly expired) period must never block starting a new one.
          reuseExistingSuccess: false,
        });
        if (!result.checkoutUrl) {
          return sendError(reply, 502, "CHECKOUT_FAILED", "Could not start the checkout. Please try again.");
        }
        return reply.send({ data: { checkoutUrl: result.checkoutUrl, paymentId: result.paymentId }, error: null });
      } catch (err) {
        if (err instanceof PaymentProviderError) {
          request.log.error({ err }, "Chapa Pro checkout initialization failed");
          return sendError(reply, 502, "CHECKOUT_FAILED", "Could not start the checkout. Please try again.");
        }
        throw err;
      }
    }

    // Already subscribed: switching plans goes through /change-plan, never a second subscription.
    if (user.subscriptionProvider === "POLAR" && user.polarSubscriptionId && hasActiveProAccess(user)) {
      return sendError(reply, 409, "ALREADY_SUBSCRIBED", "You already have a subscription. Change your plan instead.");
    }

    const planDef = getSubscriptionPlan(parsed.data.tier, parsed.data.period);
    if (!planDef.productId) {
      return sendError(
        reply,
        503,
        "PLAN_NOT_CONFIGURED",
        `The ${planDef.label} plan isn't available yet. Please try another plan.`
      );
    }

    try {
      const checkoutUrl = await createProCheckoutUrl({
        userId: user.id,
        email: user.email,
        productId: planDef.productId,
      });
      return reply.send({ data: { checkoutUrl }, error: null });
    } catch (err) {
      if (err instanceof PolarCheckoutError) {
        request.log.error({ err }, "Polar checkout creation failed");
        return sendError(reply, 502, "CHECKOUT_FAILED", "Could not start the checkout. Please try again.");
      }
      throw err;
    }
  });

  // The frontend's sole source of truth for Pro access and free-generation
  // usage — never derive either from client-side state.
  app.get("/api/v1/subscriptions/status", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    return reply.send({ data: await toStatusResponse(user), error: null });
  });

  // Schedules cancellation at the end of the current billing period — the
  // subscription (and Pro access) stays active until then, nothing already
  // paid is refunded, and Polar simply won't renew it afterward. Never an
  // immediate revoke. Polar-only: a Chapa-granted period has nothing to
  // cancel (it just expires), so a Chapa user never has polarSubscriptionId
  // set and is correctly rejected here.
  app.post("/api/v1/subscriptions/cancel", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    if (!user.polarSubscriptionId || !hasActiveProAccess(user)) {
      return sendError(reply, 404, "NO_ACTIVE_SUBSCRIPTION", "There is no active Pro subscription to cancel");
    }

    if (user.subscriptionCancelAtPeriodEnd) {
      return reply.send({ data: await toStatusResponse(user), error: null });
    }

    try {
      const cancelled = await cancelProSubscriptionAtPeriodEnd(user.polarSubscriptionId);
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: cancelled.status,
          subscriptionCurrentPeriodEnd: new Date(cancelled.currentPeriodEnd),
          subscriptionCancelAtPeriodEnd: cancelled.cancelAtPeriodEnd,
        },
      });
      return reply.send({ data: await toStatusResponse(updated), error: null });
    } catch (err) {
      if (err instanceof PolarCancelError) {
        request.log.error({ err }, "Polar subscription cancellation failed");
        return sendError(reply, 502, "CANCEL_FAILED", "Could not cancel the subscription. Please try again.");
      }
      throw err;
    }
  });

  // Switches an active Polar subscription to another plan (Plus / Pro) or
  // billing period (weekly / monthly / quarterly). The current plan ends and the new one replaces it on the same
  // subscription — prorated, never a second subscription or a double charge.
  // A Chapa period can't be changed (it's a one-off payment that just
  // expires), so this is Polar-only like /cancel.
  app.post("/api/v1/subscriptions/change-plan", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = changePlanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    if (user.subscriptionProvider !== "POLAR" || !user.polarSubscriptionId || !hasActiveProAccess(user)) {
      return sendError(reply, 404, "NO_ACTIVE_SUBSCRIPTION", "There is no active Pro subscription to change");
    }

    const planDef = getSubscriptionPlan(parsed.data.tier, parsed.data.period);
    if (!planDef.productId) {
      return sendError(reply, 503, "PLAN_NOT_CONFIGURED", `The ${planDef.label} plan isn't available yet. Please try another plan.`);
    }
    if (planDef.productId === user.polarProductId && !user.subscriptionCancelAtPeriodEnd) {
      return reply.send({ data: await toStatusResponse(user), error: null });
    }

    try {
      const updated = await changeProSubscriptionProduct(
        user.polarSubscriptionId,
        planDef.productId,
        user.subscriptionCancelAtPeriodEnd
      );
      // Same write the webhook does, so the plan shows immediately rather
      // than after Polar's subscription.updated event arrives.
      await applySubscriptionSnapshot(updated);
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      return reply.send({ data: await toStatusResponse(fresh), error: null });
    } catch (err) {
      if (err instanceof PolarCancelError) {
        request.log.error({ err }, "Polar subscription plan change failed");
        return sendError(reply, 502, "CHANGE_PLAN_FAILED", "Could not change your plan. Please try again.");
      }
      throw err;
    }
  });

  // Reverses a pending cancel-at-period-end — the subscription goes back to
  // renewing normally at the end of the current period. Polar-only, same
  // reasoning as /cancel.
  app.post("/api/v1/subscriptions/resume", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    if (!user.polarSubscriptionId || !hasActiveProAccess(user)) {
      return sendError(reply, 404, "NO_ACTIVE_SUBSCRIPTION", "There is no active Pro subscription to resume");
    }

    if (!user.subscriptionCancelAtPeriodEnd) {
      return reply.send({ data: await toStatusResponse(user), error: null });
    }

    try {
      const resumed = await resumeProSubscription(user.polarSubscriptionId);
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: resumed.status,
          subscriptionCurrentPeriodEnd: new Date(resumed.currentPeriodEnd),
          subscriptionCancelAtPeriodEnd: resumed.cancelAtPeriodEnd,
        },
      });
      return reply.send({ data: await toStatusResponse(updated), error: null });
    } catch (err) {
      if (err instanceof PolarCancelError) {
        request.log.error({ err }, "Polar subscription resume failed");
        return sendError(reply, 502, "RESUME_FAILED", "Could not resume the subscription. Please try again.");
      }
      throw err;
    }
  });
}
