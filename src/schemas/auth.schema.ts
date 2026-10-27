import { z } from "zod";
import {
  ACQUISITION_SOURCES,
  CAREER_STAGES,
  SIGNUP_INTENTS,
  SIGNUP_SURFACES,
  signupAttributionSchema,
} from "./onboarding.schema";

export const PROFILE_AUTO_SYNC_MODES = ["ask", "always", "never"] as const;
export type ProfileAutoSync = (typeof PROFILE_AUTO_SYNC_MODES)[number];

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, "token is required").max(200),
});

export const verifyCodeSchema = z.object({
  email: z.string().email(),
  // Digits only once spaces/dashes from a paste are dropped (see normalizeCode).
  code: z.string().max(20).refine((value) => value.replace(/\D/g, "").length === 6, "Enter the 6-digit code"),
});

export const resendVerificationSchema = z.object({
  email: z.string().email(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "token is required").max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, "idToken is required"),
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1, "Full name cannot be empty").optional(),
  email: z.string().trim().email().optional(),
  firstName: z.string().trim().min(1, "First name cannot be empty").max(80).optional(),
  lastName: z.string().trim().min(1, "Last name cannot be empty").max(80).optional(),
  // "" clears the phone number.
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+\d\s().-]*$/, "Use digits, spaces and + ( ) - only")
    .optional(),
  // Either a catalog title or the user's own; the server links it to the
  // catalog when it matches (see PATCH /auth/me).
  occupationTitle: z.string().trim().min(1, "Occupation cannot be empty").max(100).optional(),
  // Every profession, main one first (replaces the list; [] clears it).
  professions: z.array(z.string().trim().min(1).max(100)).max(5, "Add up to 5 professions").optional(),
  // Set once, when the onboarding flow is submitted.
  completeOnboarding: z.literal(true).optional(),
  profileAutoSync: z.enum(PROFILE_AUTO_SYNC_MODES).optional(),
  // Onboarding answers (null clears one, e.g. from Account settings).
  signupIntent: z.enum(SIGNUP_INTENTS).nullable().optional(),
  careerStage: z.enum(CAREER_STAGES).nullable().optional(),
  acquisitionSource: z.enum(ACQUISITION_SOURCES).nullable().optional(),
  acquisitionDetail: z.string().trim().max(120).nullable().optional(),
  signupSurface: z.enum(SIGNUP_SURFACES).optional(),
  // Kept only the first time it's sent.
  signupAttribution: signupAttributionSchema.optional(),
});

// A /try sign-up (or an upload during onboarding) finished its first CV: fill
// the account's empty details from it (see services/onboarding.service.ts).
export const onboardingFromCvSchema = z.object({
  cvDocumentId: z.string().uuid(),
  flow: z.enum(SIGNUP_INTENTS),
  surface: z.enum(["try", "dashboard"]),
  signupAttribution: signupAttributionSchema.optional(),
});

// currentPassword is required when the account already has one; a
// Google-only account omits it to set its first password.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// Changing the email re-confirms identity with the password when the account
// has one (a Google-only account has none to give).
export const changeEmailSchema = z.object({
  newEmail: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(1).optional(),
});

export const confirmEmailChangeSchema = z.object({
  code: z.string().max(20).refine((value) => value.replace(/\D/g, "").length === 6, "Enter the 6-digit code"),
});

// Why someone deleted their account (optional, asked in the delete dialog).
export const DELETION_REASONS = [
  "got_the_job",
  "not_useful",
  "too_expensive",
  "poor_results",
  "privacy",
  "other_service",
  "other",
] as const;

// Deleting an account re-confirms identity: the password when the account has
// one, otherwise the account's email typed back.
export const deleteAccountSchema = z.object({
  password: z.string().min(1).optional(),
  confirmEmail: z.string().trim().optional(),
  // Optional, kept without the user (see Feedback "account_deletion").
  reason: z.enum(DELETION_REASONS).optional(),
  comment: z.string().trim().max(1000).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
