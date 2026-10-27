import type { FastifyInstance } from "fastify";
import type { Payment } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { initializePaymentSchema } from "../schemas/payment.schema";
import {
  initializePaymentForResource,
  verifyAndSyncPayment,
} from "../services/payment.service";
import { ProductResourceNotFoundError } from "../services/payment/products";
import { PaymentProviderError } from "../services/payment";
import { verifyChapaWebhookSignature } from "../services/payment/signature";

// Never exposes Chapa-specific fields (merchantReference, providerReference,
// checkoutUrl) beyond what the frontend actually needs.
function toPublicPayment(payment: Payment) {
  return {
    id: payment.id,
    productType: payment.productType,
    resourceId: payment.resourceId,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

export async function paymentRoutes(app: FastifyInstance) {
  app.post("/api/v1/payments/initialize", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = initializePaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    try {
      const result = await initializePaymentForResource(request.userId, {
        productType: parsed.data.productType,
        resourceId: parsed.data.resourceId,
        customer: {
          email: user.email,
          firstName: user.fullName?.split(" ")[0],
          lastName: user.fullName?.split(" ").slice(1).join(" ") || undefined,
        },
      });

      return reply.code(201).send({ data: result, error: null });
    } catch (err) {
      if (err instanceof ProductResourceNotFoundError) {
        return sendError(reply, 404, "RESOURCE_NOT_FOUND", "The item you're trying to pay for was not found");
      }
      if (err instanceof PaymentProviderError) {
        request.log.error({ err }, "Chapa payment initialization failed");
        return sendError(reply, 502, "PAYMENT_INIT_FAILED", "Could not start the payment. Please try again.");
      }
      throw err;
    }
  });

  // Status retrieval also doubles as "return handling": the frontend calls
  // this after the user comes back from Chapa's checkout, and a PENDING
  // payment is re-verified against Chapa right here rather than trusting
  // whatever (if anything) Chapa put in the redirect's query string.
  app.get("/api/v1/payments/:id/status", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const payment = await prisma.payment.findFirst({ where: { id, userId: request.userId } });
    if (!payment) {
      return sendError(reply, 404, "PAYMENT_NOT_FOUND", "Payment not found");
    }

    try {
      const updated = await verifyAndSyncPayment(payment);
      return reply.send({ data: toPublicPayment(updated), error: null });
    } catch (err) {
      if (err instanceof PaymentProviderError) {
        request.log.error({ err }, "Chapa payment verification failed");
        // Verification itself failing is not the same as the payment having
        // failed — report the last known (still pending) status rather than
        // masking a transient provider error as a payment failure.
        return reply.send({ data: toPublicPayment(payment), error: null });
      }
      throw err;
    }
  });

  // Chapa calls this directly — never behind requireAuth. Authenticity comes
  // from the HMAC signature, not a session. Requires the raw body (see the
  // route config below and its registration in server.ts).
  app.post(
    "/api/v1/payments/webhook/chapa",
    { config: { rawBody: true } },
    async (request, reply) => {
      const signature = request.headers["x-chapa-signature"] as string | undefined;
      const rawBody = (request as unknown as { rawBody?: string }).rawBody;

      if (!rawBody || !verifyChapaWebhookSignature(rawBody, signature)) {
        return sendError(reply, 401, "INVALID_SIGNATURE", "Invalid webhook signature");
      }

      const body = request.body as { merchant_reference?: string } | undefined;
      const merchantReference = body?.merchant_reference;
      if (!merchantReference) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Missing merchant_reference");
      }

      const payment = await prisma.payment.findUnique({ where: { merchantReference } });
      if (!payment) {
        // Unknown reference — ack anyway so Chapa doesn't retry indefinitely
        // for a payment that isn't (or is no longer) ours.
        return reply.send({ data: { received: true }, error: null });
      }

      // The webhook body's claimed status is never trusted directly — it
      // only tells us WHICH payment to re-verify with Chapa. Idempotent:
      // verifyAndSyncPayment no-ops once a payment is already SUCCESS/FAILED.
      try {
        await verifyAndSyncPayment(payment);
      } catch (err) {
        request.log.error({ err }, "Chapa webhook verification failed");
      }

      return reply.send({ data: { received: true }, error: null });
    }
  );
}
