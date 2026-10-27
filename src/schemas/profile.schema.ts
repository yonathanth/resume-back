import { z } from "zod";
import { profileContentInputSchema } from "./profile-content.schema";

const title = z.string().trim().min(1, "Role title is required").max(120, "Role title is too long");

export const createProfileSchema = z.object({
  title,
  // Picked from the occupation catalog in the UI; a typed custom title has none.
  occupationId: z.string().min(1).optional(),
  content: profileContentInputSchema.optional(),
  // Start from a copy of another of the user's profiles (content only).
  copyFromProfileId: z.string().min(1).optional(),
});

export const updateProfileSchema = z
  .object({
    // The version the client loaded — the update is rejected with 409 if the
    // profile changed since (another tab, or a CV merge).
    version: z.number().int().min(1),
    title: title.optional(),
    occupationId: z.string().min(1).nullable().optional(),
    content: profileContentInputSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.occupationId !== undefined || body.content !== undefined, {
    message: "Nothing to update",
  });

export const revertProfileChangeSchema = z.object({
  version: z.number().int().min(1),
});

// Create a profile from a CV, or merge the CV into an existing profile.
export const profileFromCvSchema = z.object({
  cvDocumentId: z.string().min(1),
  // Merge into this profile. Omit to create a new one.
  profileId: z.string().min(1).optional(),
  // New profile's role; defaults to the CV's headline.
  title: title.optional(),
  occupationId: z.string().min(1).optional(),
  // Take the CV's facts but not its wording — for a CV that was itself
  // written from a profile (its wording is the AI's, not the user's).
  factsOnly: z.boolean().optional(),
});

export const suggestProfileForCvSchema = z.object({
  cvDocumentId: z.string().min(1),
  factsOnly: z.boolean().optional(),
  /** The profile the CV was written from: matched directly, so its preview is always computed. */
  profileId: z.string().min(1).optional(),
});

export const wordingPreviewSchema = z.object({
  cvDocumentId: z.string().min(1),
  // The CV that was improved, when it differs from cvDocumentId — its
  // profile link is used if the new CV has none.
  sourceCvId: z.string().min(1).optional(),
});

export const applyWordingSchema = z.object({
  cvDocumentId: z.string().min(1),
  version: z.number().int().min(1),
  // Proposal keys the user approved (see WordingProposal.key).
  keys: z.array(z.string().min(1).max(200)).max(200),
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ProfileFromCvInput = z.infer<typeof profileFromCvSchema>;
