import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { searchOccupations } from "../services/occupation.service";
import { sendError } from "../utils/http-error";

const searchQuerySchema = z.object({
  q: z.string().max(80).optional().default(""),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

export async function occupationRoutes(app: FastifyInstance) {
  // Typeahead for the onboarding flow and Account settings. Users may still
  // save a title that isn't in the catalog — see PATCH /auth/me.
  app.get("/api/v1/occupations", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid query");
    }
    const results = await searchOccupations(parsed.data.q, parsed.data.limit);
    return reply.send({ data: results, error: null });
  });
}
