import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { webhooks } from "@polar-sh/sdk/2026-10";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sendError } from "../utils/http-error";
import { isSubscriptionEvent, syncSubscriptionFromEvent } from "../services/polar/subscription-sync.service";
import { isOrderPaidEvent, grantCreditFromOrder } from "../services/polar/credit-fulfillment.service";

// The 1.0 prerelease line moved these off the removed `@polar-sh/sdk/webhooks`
// subpath and onto the `webhooks` namespace of the API-versioned entrypoint,
// renamed the error class, and made validateEvent async.
const { validateEvent, PolarWebhookVerificationError } = webhooks;

export async function webhookRoutes(app: FastifyInstance) {
  // Polar calls this directly — never behind requireAuth. Authenticity comes
  // from the Standard Webhooks signature, not a session. Requires the raw
  // body (see the route config below and its registration in server.ts).
  app.post(
    "/api/v1/webhooks/polar",
    { config: { rawBody: true } },
    async (request, reply) => {
      const rawBody = (request as unknown as { rawBody?: string }).rawBody;
      if (!rawBody) {
        return sendError(reply, 400, "MISSING_BODY", "Missing raw request body");
      }

      let event;
      try {
        event = await validateEvent(rawBody, request.headers as Record<string, string>, env.POLAR_WEBHOOK_SECRET);
      } catch (err) {
        if (err instanceof PolarWebhookVerificationError) {
          return sendError(reply, 401, "INVALID_SIGNATURE", "Invalid webhook signature");
        }
        throw err;
      }

      // A one-time pay-per-use purchase (New CV / Tailoring credit) also
      // fires "order.paid" — distinct from a subscription's recurring
      // invoice, which carries a non-null subscription_id (filtered out
      // inside grantCreditFromOrder itself, not here, since that's the only
      // place that actually inspects it).
      const trackedResourceId = isSubscriptionEvent(event)
        ? event.data.id
        : isOrderPaidEvent(event)
          ? event.data.id
          : null;

      // Dedupe on the Standard Webhooks delivery id: Polar retries a
      // delivery with the same "webhook-id" on timeout or a non-2xx
      // response, so a repeat must be a no-op rather than re-applying the
      // subscription state a second time. The row also records how
      // processing went, for the admin's webhook view and retries.
      const webhookId = request.headers["webhook-id"] as string | undefined;
      let recordId: string | null = null;
      if (webhookId) {
        try {
          const record = await prisma.webhookEvent.create({
            data: {
              provider: "POLAR",
              eventId: webhookId,
              eventType: event.type,
              resourceId: trackedResourceId,
              status: trackedResourceId ? "received" : "ignored",
            },
          });
          recordId = record.id;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            return reply.send({ data: { received: true }, error: null });
          }
          throw err;
        }
      }

      if (isSubscriptionEvent(event)) {
        let outcome: { status: string; error: string | null };
        try {
          const userId = await syncSubscriptionFromEvent(event);
          outcome = userId
            ? { status: "processed", error: null }
            : { status: "unmatched", error: "No GoMoxie user matches this Polar customer (external id, customer id or email)" };
        } catch (err) {
          request.log.error({ err }, "Polar subscription sync failed");
          outcome = { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "Sync failed" };
        }
        if (recordId) {
          await prisma.webhookEvent
            .update({ where: { id: recordId }, data: { ...outcome, processedAt: new Date() } })
            .catch((err) => request.log.error({ err }, "Failed to record webhook outcome"));
        }
      } else if (isOrderPaidEvent(event)) {
        let outcome: { status: string; error: string | null };
        try {
          const userId = await grantCreditFromOrder(event.data);
          outcome = userId
            ? { status: "processed", error: null }
            : {
                status: "unmatched",
                error: "Not a recognized pay-per-use order, or no GoMoxie user matches this Polar order",
              };
        } catch (err) {
          request.log.error({ err }, "Polar credit fulfillment failed");
          outcome = { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "Fulfillment failed" };
        }
        if (recordId) {
          await prisma.webhookEvent
            .update({ where: { id: recordId }, data: { ...outcome, processedAt: new Date() } })
            .catch((err) => request.log.error({ err }, "Failed to record webhook outcome"));
        }
      }

      // Ack every other event type (customer.*, checkout.*, etc.) too, even
      // though we don't act on them — Polar retries on anything but a 2xx.
      return reply.send({ data: { received: true }, error: null });
    }
  );
}
