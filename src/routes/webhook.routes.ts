import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { UnwrapWebhookEvent } from "dodopayments/resources/webhooks/webhooks";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendError } from "../utils/http-error";
import { dodo } from "../services/dodo/client";
import { applySubscriptionSnapshot } from "../services/dodo/subscription-sync.service";
import { fulfillOneTimePayment, reverseRefundedPayment } from "../services/dodo/payment-fulfillment.service";

type Outcome = { status: "processed" | "unmatched" | "failed" | "ignored"; error: string | null };

/** Every "subscription.*" event carries the full subscription as `data`. */
type SubscriptionEvent = Extract<UnwrapWebhookEvent, { type: `subscription.${string}` }>;
const isSubscriptionEvent = (event: UnwrapWebhookEvent): event is SubscriptionEvent => event.type.startsWith("subscription.");

/** The Dodo object an event is about — what an admin retry re-fetches (subscriptions only). */
function trackedResourceId(event: UnwrapWebhookEvent): string | null {
  if (isSubscriptionEvent(event)) return event.data.subscription_id;
  if (event.type === "payment.succeeded") return event.data.payment_id;
  if (event.type === "refund.succeeded") return event.data.refund_id;
  return null;
}

async function processEvent(event: UnwrapWebhookEvent): Promise<Outcome> {
  if (isSubscriptionEvent(event)) {
    const userId = await applySubscriptionSnapshot(event.data);
    return userId
      ? { status: "processed", error: null }
      : { status: "unmatched", error: "No gomoxie user matches this Dodo customer (customer id, checkout userId or email)" };
  }
  if (event.type === "payment.succeeded") {
    // A subscription's own payments are handled by its subscription.* events.
    if (event.data.subscription_id) return { status: "ignored", error: null };
    const userId = await fulfillOneTimePayment(event.data);
    return userId
      ? { status: "processed", error: null }
      : { status: "unmatched", error: "Not a recognized one-time product, or no gomoxie user (or CV) matches this payment" };
  }
  if (event.type === "refund.succeeded") {
    const outcome = await reverseRefundedPayment(event.data);
    if (outcome.status === "processed") return { status: "processed", error: null };
    return { status: outcome.status, error: outcome.reason };
  }
  return { status: "ignored", error: null };
}

export async function webhookRoutes(app: FastifyInstance) {
  // Dodo calls this directly — never behind requireAuth. Authenticity comes
  // from the Standard Webhooks signature (webhook-id / webhook-timestamp /
  // webhook-signature headers), checked against the exact raw body.
  app.post("/api/v1/webhooks/dodo", { config: { rawBody: true } }, async (request, reply) => {
    if (!env.DODO_PAYMENTS_WEBHOOK_KEY || !env.DODO_PAYMENTS_API_KEY) {
      request.log.error("Dodo webhook received but DODO_PAYMENTS_WEBHOOK_KEY / DODO_PAYMENTS_API_KEY isn't set");
      return sendError(reply, 503, "PAYMENTS_NOT_CONFIGURED", "Payments aren't configured");
    }
    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) return sendError(reply, 400, "MISSING_BODY", "Missing raw request body");

    const headers = {
      "webhook-id": String(request.headers["webhook-id"] ?? ""),
      "webhook-timestamp": String(request.headers["webhook-timestamp"] ?? ""),
      "webhook-signature": String(request.headers["webhook-signature"] ?? ""),
    };
    let event: UnwrapWebhookEvent;
    try {
      event = dodo().webhooks.unwrap(rawBody, { headers });
    } catch {
      return sendError(reply, 401, "INVALID_SIGNATURE", "Invalid webhook signature");
    }

    // Dedupe on the delivery id: Dodo retries a delivery with the same
    // "webhook-id" on a timeout or a non-2xx response. A repeat of one that
    // was handled is a no-op; a repeat of one that failed is processed again.
    // The row also records how processing went, for the admin's webhook view.
    const resourceId = trackedResourceId(event);
    let recordId: string;
    try {
      const record = await prisma.webhookEvent.create({
        data: {
          provider: "DODO",
          eventId: headers["webhook-id"],
          eventType: event.type,
          resourceId,
          status: resourceId ? "received" : "ignored",
        },
      });
      recordId = record.id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const existing = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "DODO", eventId: headers["webhook-id"] } },
      });
      if (!existing || (existing.status !== "failed" && existing.status !== "received")) {
        return reply.send({ data: { received: true }, error: null });
      }
      recordId = existing.id;
    }

    if (!resourceId) return reply.send({ data: { received: true }, error: null });

    let outcome: Outcome;
    try {
      outcome = await processEvent(event);
    } catch (err) {
      request.log.error({ err, type: event.type }, "Dodo webhook processing failed");
      outcome = { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "Processing failed" };
    }
    await prisma.webhookEvent
      .update({ where: { id: recordId }, data: { ...outcome, processedAt: new Date() } })
      .catch((err) => request.log.error({ err }, "Failed to record webhook outcome"));

    // A failure answers 500 so Dodo delivers it again (and processing is
    // retried, see above); the admin can also re-sync it from Billing → Webhooks.
    if (outcome.status === "failed") return sendError(reply, 500, "WEBHOOK_FAILED", "Processing failed; please retry");
    return reply.send({ data: { received: true }, error: null });
  });
}
