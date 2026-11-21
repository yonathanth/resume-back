import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import rawBody from "fastify-raw-body";
import { allowedOrigins, env } from "./config/env";
import { openApiSpecification } from "./docs/openapi";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth.routes";
import { profileRoutes } from "./routes/profile.routes";
import { cvRoutes } from "./routes/cv.routes";
import { cvScoreRoutes } from "./routes/cv-score.routes";
import { importRoutes } from "./routes/import.routes";
import { paymentRoutes } from "./routes/payment.routes";
import { subscriptionRoutes } from "./routes/subscription.routes";
import { purchaseRoutes } from "./routes/purchases.routes";
import { webhookRoutes } from "./routes/webhook.routes";
import { templateRoutes } from "./routes/template.routes";
import { aiTestRoutes } from "./routes/aiTest.routes";
import { occupationRoutes } from "./routes/occupation.routes";
import { notificationRoutes } from "./routes/notification.routes";
import { activationRoutes } from "./routes/activation.routes";
import { adminRoutes } from "./routes/admin";
import { partnerRoutes, partnerScoreRoutes } from "./routes/partner.routes";
import { closeRenderBrowser } from "./services/render.service";
import { isDbUnavailable, sendDbUnavailable } from "./utils/db-errors";

// Builds the app without listening, so tests can drive it with app.inject().
export async function buildServer(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: env.TRUST_PROXY });
  app.addHook("onClose", closeRenderBrowser);

  // @fastify/cors only does an exact string match, so it gets the split list
  // (a literal comma-joined string would never match a real Origin header).
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  });
  // Only the Chapa and Dodo webhook routes opt in (`config: { rawBody: true }`)
  // — needed to verify their signatures against the exact raw bytes.
  await app.register(rawBody, { global: false });

  await app.register(swagger, {
    mode: "static",
    specification: { document: openApiSpecification },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // A database hiccup is a 503 the client can act on, not a bare 500. Only
  // reads are marked safe to repeat here: a write may have gone halfway.
  // Everything else falls through to Fastify's default handler.
  app.setErrorHandler((error, request, reply) => {
    if (isDbUnavailable(error)) {
      request.log.warn({ err: error }, "database unavailable");
      return sendDbUnavailable(reply, { retryable: request.method === "GET" || request.method === "HEAD" });
    }
    throw error;
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(profileRoutes);
  await app.register(cvRoutes);
  await app.register(cvScoreRoutes);
  await app.register(importRoutes);
  await app.register(paymentRoutes);
  await app.register(subscriptionRoutes);
  await app.register(purchaseRoutes);
  await app.register(webhookRoutes);
  await app.register(templateRoutes);
  await app.register(occupationRoutes);
  await app.register(notificationRoutes);
  await app.register(activationRoutes);
  await app.register(adminRoutes);
  await app.register(partnerRoutes);
  await app.register(partnerScoreRoutes);

  if (env.NODE_ENV !== "production") {
    await app.register(aiTestRoutes);
  }

  return app;
}
