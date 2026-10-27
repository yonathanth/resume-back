import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import {
  createProfileSchema,
  profileFromCvSchema,
  revertProfileChangeSchema,
  applyWordingSchema,
  suggestProfileForCvSchema,
  updateProfileSchema,
  wordingPreviewSchema,
} from "../schemas/profile.schema";
import { previewCvWording, suggestProfileForCv } from "../services/profileMatch.service";
import { sendError } from "../utils/http-error";
import { FeatureUnavailableError, ProFeatureRequiredError, assertFeatureAccess } from "../services/entitlement.service";
import {
  ProfileError,
  applyCvWording,
  createProfile,
  deleteProfile,
  getOwnedProfile,
  getProfileDetail,
  listProfiles,
  revertProfileChange,
  syncCvIntoProfile,
  updateProfile,
} from "../services/profile.service";
import { profileContentToCvContent } from "../services/profileContent.service";
import { getProfileDefaults } from "../services/profileDefaults.service";
import { trackEvent } from "../services/events.service";

// Career profiles: one per user per role, Pro-only to create or change.
// Reads stay open on every plan so a downgraded user keeps (read-only)
// access to their own profiles; deleting is also always allowed.

const FEATURE = "careerProfiles" as const;

function parseBody<T>(schema: ZodType<T>, request: FastifyRequest, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    sendError(reply, 400, "VALIDATION_ERROR", `${issue?.message ?? "Invalid request body"}${where}`);
    return null;
  }
  return parsed.data;
}

function sendProfileError(reply: FastifyReply, err: unknown) {
  if (err instanceof ProfileError) {
    return reply.code(err.status).send({ data: null, error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
  }
  if (err instanceof ProFeatureRequiredError) {
    return sendError(reply, 402, "PRO_REQUIRED", err.message);
  }
  if (err instanceof FeatureUnavailableError) {
    return sendError(reply, 403, "FEATURE_UNAVAILABLE", err.message);
  }
  throw err;
}

export async function profileRoutes(app: FastifyInstance) {
  app.get("/api/v1/profiles", { preHandler: requireAuth }, async (request, reply) => {
    return reply.send({ data: await listProfiles(request.userId), error: null });
  });

  app.get("/api/v1/profiles/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return reply.send({ data: await getProfileDetail(request.userId, id), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  // The profile as CV content (account contact details filled in) — the
  // source for generating a new CV from this profile.
  app.get("/api/v1/profiles/:id/cv-content", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      const profile = await getOwnedProfile(request.userId, id);
      const defaults = await getProfileDefaults(request.userId);
      const content = profileContentToCvContent(profile.content, defaults ?? {});
      return reply.send({ data: { content, profileVersion: profile.version }, error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.post("/api/v1/profiles", { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(createProfileSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      const profile = await createProfile(request.userId, body);
      trackEvent("career_profile_created", request.userId, { from: "manual" });
      return reply.code(201).send({ data: profile, error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.patch("/api/v1/profiles/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updateProfileSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      return reply.send({ data: await updateProfile(request.userId, id, body), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.delete("/api/v1/profiles/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteProfile(request.userId, id);
      return reply.send({ data: { success: true }, error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.post("/api/v1/profiles/:id/changes/:changeId/revert", { preHandler: requireAuth }, async (request, reply) => {
    const { id, changeId } = request.params as { id: string; changeId: string };
    const body = parseBody(revertProfileChangeSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      return reply.send({ data: await revertProfileChange(request.userId, id, changeId, body.version), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  // Which profile a freshly made CV belongs to (same role / related roles)
  // and what saving it would change — powers the "update your profile?"
  // card. Read-only; no AI unless the free checks find nothing.
  app.post("/api/v1/profiles/suggest-for-cv", { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(suggestProfileForCvSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      return reply.send({ data: await suggestProfileForCv(request.userId, body), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  // Enhance: where the improved CV's wording differs from the profile's,
  // entry by entry, for the user to approve. Read-only.
  app.post("/api/v1/profiles/wording/preview", { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(wordingPreviewSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      return reply.send({ data: await previewCvWording(request.userId, body), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.post("/api/v1/profiles/:id/wording", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(applyWordingSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      return reply.send({ data: await applyCvWording(request.userId, id, body), error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  // Creates a profile from a CV (or merges the CV into an existing profile)
  // and links the CV to it. Returns what changed so the UI can confirm it.
  app.post("/api/v1/profiles/from-cv", { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(profileFromCvSchema, request, reply);
    if (!body) return;
    try {
      await assertFeatureAccess(request.userId, FEATURE);
      const result = await syncCvIntoProfile(request.userId, body);
      if (result.created) trackEvent("career_profile_created", request.userId, { from: "cv" });
      return reply.code(result.created ? 201 : 200).send({ data: result, error: null });
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });
}
