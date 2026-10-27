import type { FastifyInstance } from "fastify";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { purchaseCheckoutSchema } from "../schemas/subscription.schema";
import { getOneTimeProduct, type OneTimeProduct } from "../services/polar/plans";
import { createProCheckoutUrl, PolarCheckoutError } from "../services/polar/checkout.service";
import { getPricingCatalog, lifetimeOfferStatus } from "../services/pricing.service";
import { isCvLocked } from "../services/entitlement.service";
import { resolveAccess } from "../services/access.service";

// One-time purchases — never a subscription: Plus Lifetime, and unlocking one
// CV's download. Fulfillment (the LIFETIME_PLUS grant, the CV's unlockedAt)
// happens off the Polar `order.paid` webhook, not here — see webhook.routes.ts
// and services/polar/credit-fulfillment.service.ts.
export async function purchaseRoutes(app: FastifyInstance) {
  // The public price list — the pricing page shows it signed out too.
  app.get("/api/v1/pricing", async (_request, reply) => {
    return reply.send({ data: await getPricingCatalog(), error: null });
  });

  app.post("/api/v1/purchases/checkout", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = purchaseCheckoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "User not found");
    }

    let product: OneTimeProduct;
    const metadata: Record<string, string> = {};
    if (parsed.data.product === "plus_lifetime") {
      const offer = await lifetimeOfferStatus();
      if (!offer.available) {
        return sendError(reply, 410, "OFFER_UNAVAILABLE", "The Plus Lifetime deal isn't available right now.");
      }
      product = "plus_lifetime";
    } else {
      const doc = await prisma.cVDocument.findFirst({
        where: { id: parsed.data.cvDocumentId, userId: user.id },
        select: { id: true, unlockProduct: true, lockedTier: true, unlockedAt: true },
      });
      if (!doc) return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
      const access = await resolveAccess(user.id);
      if (!isCvLocked(doc, access?.tier ?? "free")) {
        return sendError(reply, 409, "CV_ALREADY_UNLOCKED", "This CV is already unlocked. You can download it.");
      }
      product = doc.unlockProduct === "cv_edit" ? "cv_edit" : "cv_new";
      metadata.cvDocumentId = doc.id;
    }

    const productDef = getOneTimeProduct(product);
    if (!productDef.productId) {
      return sendError(reply, 503, "PRODUCT_NOT_CONFIGURED", `${productDef.label} isn't available yet. Please try again later.`);
    }

    try {
      const checkoutUrl = await createProCheckoutUrl({
        userId: user.id,
        email: user.email,
        productId: productDef.productId,
        metadata: { purchaseType: product, ...metadata },
      });
      return reply.send({ data: { checkoutUrl }, error: null });
    } catch (err) {
      if (err instanceof PolarCheckoutError) {
        request.log.error({ err }, "Polar one-time checkout creation failed");
        return sendError(reply, 502, "CHECKOUT_FAILED", "Could not start the checkout. Please try again.");
      }
      throw err;
    }
  });
}
