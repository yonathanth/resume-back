import { z } from "zod";

// The onboarding answers stored on User (signupIntent, careerStage,
// acquisitionSource, signupSurface). Plain strings in the database, like the
// rest of this schema; these lists are the only values the API accepts.

export const SIGNUP_INTENTS = ["create", "tailor", "improve"] as const;
export type SignupIntent = (typeof SIGNUP_INTENTS)[number];

export const CAREER_STAGES = ["student", "entry", "mid", "senior", "career_change"] as const;
export type CareerStage = (typeof CAREER_STAGES)[number];

export const ACQUISITION_SOURCES = ["search", "social", "telegram", "friend", "school", "ad", "other"] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

export const SIGNUP_SURFACES = ["dashboard", "try"] as const;
export type SignupSurface = (typeof SIGNUP_SURFACES)[number];

const attributionText = z.string().trim().max(200);

// First-touch attribution the browser captured before sign-up. Every field
// is optional and short; anything else is dropped.
export const signupAttributionSchema = z
  .object({
    utmSource: attributionText.optional(),
    utmMedium: attributionText.optional(),
    utmCampaign: attributionText.optional(),
    utmContent: attributionText.optional(),
    utmTerm: attributionText.optional(),
    // Host only (e.g. "t.me"), never a full URL with someone's query string.
    referrer: attributionText.optional(),
    landingPath: attributionText.optional(),
    // The /go link they arrived through, e.g. "create" or "template/modern".
    quickLink: attributionText.optional(),
    firstSeenAt: z.string().datetime().optional(),
  })
  .strip();
export type SignupAttribution = z.infer<typeof signupAttributionSchema>;
