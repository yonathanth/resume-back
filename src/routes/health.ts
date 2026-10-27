import type { FastifyInstance } from "fastify";
import { pdfRendererStatus } from "../services/render.service";

export async function healthRoutes(app: FastifyInstance) {
  // 503 when this server can't make PDFs (Chrome missing or won't start): the
  // host's health check then keeps the previous deploy serving instead.
  app.get("/health", async (_request, reply) => {
    const pdf = pdfRendererStatus();
    if (pdf.state === "failed") {
      return reply.code(503).send({ status: "degraded", pdf: "failed", error: pdf.error });
    }
    return { status: "ok", pdf: pdf.state };
  });
}
