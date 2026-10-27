/**
 * Hand-authored OpenAPI 3.0 document describing every route in this API.
 *
 * Routes validate requests with Zod at runtime (see src/schemas/*.ts), not
 * Fastify's JSON-schema route option, so this specification is served
 * statically via @fastify/swagger's `mode: "static"` rather than generated
 * from route schemas. Keep it in sync by hand when routes change.
 */
import type { OpenAPIV3 } from "openapi-types";

const errorResponseSchema: OpenAPIV3.SchemaObject = {
  type: "object",
  properties: {
    data: { nullable: true, example: null, description: "Always null on an error response." },
    error: {
      type: "object",
      properties: {
        code: { type: "string", description: "Machine-readable error code, e.g. PROFILE_NOT_FOUND" },
        message: { type: "string", description: "Human-readable explanation of what went wrong" },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Only present on INCOMPLETE_DOCUMENT (422) responses from finalize — the list of missing/invalid content paths, e.g. \"personal.email\" or \"skills\".",
        },
      },
      required: ["code", "message"],
    },
  },
  required: ["data", "error"],
};

function errorResponse(description: string): OpenAPIV3.ResponseObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
  };
}

function dataResponse(
  description: string,
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
): OpenAPIV3.ResponseObject {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            data: schema,
            error: { nullable: true, example: null, description: "Always null on a success response." },
          },
          required: ["data", "error"],
        },
      },
    },
  };
}

const bearerAuth: OpenAPIV3.SecurityRequirementObject[] = [{ bearerAuth: [] }];

export const openApiSpecification: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "GoMoxie API",
    version: "1.0.0",
    description:
      "API for GoMoxie: user authentication, career profiles, the step-by-step CV document wizard, CV import via file upload/OCR, and PDF rendering of finalized documents. Every endpoint responds with the envelope `{ data, error }` — exactly one of the two is non-null — except `GET /health` (bare status object) and `GET /cv/{id}/download` (raw PDF bytes).",
  },
  servers: [{ url: "/api/v1", description: "Versioned API root (all routes below are relative to this)" }],
  tags: [
    { name: "Health", description: "Service liveness check" },
    { name: "Auth", description: "Registration, login, token refresh, and session identity" },
    { name: "Profiles", description: "Career profiles — one per user per role, holding the facts CVs are generated from. Creating or changing them requires GoMoxie Pro (402 PRO_REQUIRED); reading and deleting are open on every plan." },
    { name: "CV Documents", description: "The step-by-step CV wizard: draft creation, per-step edits, and finalization" },
    { name: "Imports", description: "Uploading an existing CV file, extracting its text, and applying it to a draft" },
    { name: "Rendering", description: "Rendering CV content with a template: live HTML preview and PDF download (same template for both)" },
    { name: "Templates", description: "The CV templates the backend can render (src/templates/<id>/, registry in config/cv-templates.ts)" },
    { name: "Activation", description: "First-run state (getting-started checklist, one-time prompts), product feedback and allow-listed analytics events" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Short-lived (15 min) access token returned by register/login/refresh. Send as `Authorization: Bearer <token>`.",
      },
    },
    schemas: {
      ErrorResponse: errorResponseSchema,

      User: {
        type: "object",
        description: "The authenticated account.",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          fullName: { type: "string", nullable: true },
          firstName: { type: "string", nullable: true },
          lastName: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          occupationTitle: { type: "string", nullable: true, description: "A catalog title or the user's own." },
          occupationId: { type: "string", nullable: true, description: "Set only when occupationTitle matches the catalog." },
          professions: {
            type: "array",
            items: { type: "string" },
            description: "Every profession (up to 5), main one first; occupationTitle mirrors the first. PATCH /auth/me with `professions` replaces the list.",
          },
          onboardingCompleted: { type: "boolean" },
          signupIntent: { type: "string", nullable: true, enum: ["create", "tailor", "improve"], description: "What they came to do (onboarding)." },
          careerStage: { type: "string", nullable: true, enum: ["student", "entry", "mid", "senior", "career_change"] },
          acquisitionSource: { type: "string", nullable: true, enum: ["search", "social", "telegram", "friend", "school", "ad", "other"] },
          acquisitionDetail: { type: "string", nullable: true, description: "Free text, e.g. for source \"other\"." },
          signupSurface: { type: "string", nullable: true, enum: ["dashboard", "try"], description: "\"try\" when they signed up in the middle of a /try flow." },
          profileAutoSync: {
            type: "string",
            enum: ["ask", "always", "never"],
            description: "What happens to a matching career profile when a new CV is made. Settable via PATCH /auth/me. Creating a new profile always asks.",
          },
          hasPassword: { type: "boolean", description: "False for a Google-only account." },
          hasGoogle: { type: "boolean", description: "True once a Google account is linked." },
          createdAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "email",
          "fullName",
          "firstName",
          "lastName",
          "phone",
          "occupationTitle",
          "occupationId",
          "onboardingCompleted",
          "hasPassword",
          "hasGoogle",
          "createdAt",
        ],
      },

      AuthResult: {
        type: "object",
        description: "Returned by register and login. The refresh token is set as an httpOnly cookie, not in this body.",
        properties: {
          user: { $ref: "#/components/schemas/User" },
          accessToken: { type: "string", description: "JWT access token, valid for 15 minutes." },
        },
        required: ["user", "accessToken"],
      },

      CareerProfileListItem: {
        type: "object",
        description: "A career profile as listed — one per user per role.",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string", example: "Backend Developer" },
          roleKey: { type: "string", description: "Canonical role identity, unique per user. Seniority and wording variants share a key.", example: "backend developer" },
          seniority: { type: "string", nullable: true, example: "senior" },
          occupationId: { type: "string", format: "uuid", nullable: true },
          occupationTitle: { type: "string", nullable: true },
          occupationCategory: { type: "string", nullable: true },
          origin: { type: "string", enum: ["manual", "cv"] },
          version: { type: "integer", minimum: 1, description: "Bumped on every content change; send it back on PATCH for optimistic concurrency." },
          headline: { type: "string", nullable: true },
          counts: { type: "object", additionalProperties: { type: "integer" }, description: "Item counts per non-empty content section." },
          documentCount: { type: "integer", minimum: 0 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "title", "roleKey", "origin", "version", "counts", "documentCount", "createdAt", "updatedAt"],
      },

      ProfileContent: {
        type: "object",
        description:
          "CVContent sections (same field names) minus contact details, which live on the account. Every list item carries `id` and `meta` ({ source, sourceCvId?, locked, aliases?, addedAt, updatedAt? }); the server owns both — on writes, new items may omit `id` and `meta` is ignored. Skills are `{ name }` items. `dismissedKeys` records auto-added items the user deleted so merges don't re-add them.",
        additionalProperties: true,
      },

      CareerProfileDetail: {
        allOf: [
          { $ref: "#/components/schemas/CareerProfileListItem" },
          {
            type: "object",
            properties: {
              content: { $ref: "#/components/schemas/ProfileContent" },
              documents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    title: { type: "string", nullable: true },
                    templateId: { type: "string" },
                    status: { type: "string" },
                    profileVersion: { type: "integer", nullable: true },
                    tailored: { type: "boolean", description: "Generated against a job description." },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                  },
                },
              },
              changes: {
                type: "array",
                description: "Most recent first (up to 30).",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    kind: { type: "string", enum: ["create", "manual_edit", "merge_cv", "wording", "revert"] },
                    cvDocumentId: { type: "string", nullable: true },
                    fromVersion: { type: "integer" },
                    toVersion: { type: "integer" },
                    summary: { type: "object", nullable: true, description: "{ added, updated, removed } per-section counts, or revert/create details." },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
            required: ["content", "documents", "changes"],
          },
        ],
      },

      CVDocument: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          profileId: { type: "string", format: "uuid", nullable: true },
          profileVersion: { type: "integer", nullable: true, description: "The career profile version this CV was generated from or last synced with." },
          title: {
            type: "string",
            nullable: true,
            description: "The document's own display name, distinct from content.personal.title (the candidate's job title/headline).",
          },
          templateId: { type: "string", enum: ["professional", "modern", "minimal"], default: "professional" },
          content: { $ref: "#/components/schemas/CVContent" },
          currentStep: { $ref: "#/components/schemas/WizardStep" },
          status: { type: "string", enum: ["draft", "final"] },
          source: {
            type: "string",
            enum: ["manual", "ocr", "ai"],
            description: "How the content was produced. Currently always \"manual\" — set here for forward compatibility.",
          },
          pdfPath: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "userId",
          "profileId",
          "templateId",
          "content",
          "currentStep",
          "status",
          "source",
          "pdfPath",
          "createdAt",
          "updatedAt",
        ],
      },

      CVImport: {
        type: "object",
        description: "A single upload-and-extract attempt against an existing CV file (pdf/docx/image).",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          cvDocumentId: {
            type: "string",
            format: "uuid",
            nullable: true,
            description: "Set once this import has been applied to a draft via POST /imports/{id}/apply.",
          },
          fileType: { type: "string", enum: ["pdf", "docx", "image"] },
          filePath: { type: "string", nullable: true, description: "Always null — uploaded files are processed in memory and never stored." },
          rawText: { type: "string", nullable: true, description: "Full extracted text, populated on success." },
          extractedData: {
            allOf: [{ $ref: "#/components/schemas/CVContent" }],
            nullable: true,
            description:
              "Best-effort partial CVContent from regex heuristics (email, phone, a full_name guess) — never experience/education/skills.",
          },
          status: { type: "string", enum: ["pending", "complete", "failed"] },
          error: { type: "string", nullable: true, description: "Populated when status is \"failed\"." },
          createdAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "userId",
          "cvDocumentId",
          "fileType",
          "filePath",
          "rawText",
          "extractedData",
          "status",
          "error",
          "createdAt",
        ],
      },

      RegisterRequest: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, description: "Minimum 8 characters." },
        },
        required: ["email", "password"],
      },

      LoginRequest: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
        },
        required: ["email", "password"],
      },

      CreateProfileRequest: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          occupationId: { type: "string", description: "Occupation catalog id, when the role was picked from the catalog." },
          content: { $ref: "#/components/schemas/ProfileContent" },
          copyFromProfileId: { type: "string", description: "Start from a copy of another of the user's profiles." },
        },
        required: ["title"],
      },

      UpdateProfileRequest: {
        type: "object",
        description: "Send only what you want to change. `content` replaces the whole content; edited items become locked (merges stop touching them).",
        properties: {
          version: { type: "integer", minimum: 1, description: "The version the client loaded." },
          title: { type: "string", minLength: 1, maxLength: 120 },
          occupationId: { type: "string", nullable: true },
          content: { $ref: "#/components/schemas/ProfileContent" },
        },
        required: ["version"],
      },

      ProfileFromCvRequest: {
        type: "object",
        properties: {
          cvDocumentId: { type: "string" },
          profileId: { type: "string", description: "Merge into this profile. Omit to create a new one." },
          title: { type: "string", description: "New profile's role. Defaults to the CV's headline." },
          occupationId: { type: "string" },
          factsOnly: { type: "boolean", description: "Take the CV's facts but not its wording (e.g. a CV that was itself written from a profile)." },
        },
        required: ["cvDocumentId"],
      },

      CreateCVDocumentRequest: {
        type: "object",
        properties: {
          profileId: {
            type: "string",
            format: "uuid",
            description: "Must belong to the authenticated user; linking requires Pro (402 PRO_REQUIRED). Omit to create a standalone CV not attached to any career profile.",
          },
          templateId: { type: "string", enum: ["professional", "modern", "minimal"], default: "professional" },
          title: { type: "string", description: "The document's own display name." },
        },
      },

      ApplyImportRequest: {
        type: "object",
        properties: {
          cvDocumentId: {
            type: "string",
            format: "uuid",
            description: "The draft to merge extractedData into. Must belong to the authenticated user.",
          },
        },
        required: ["cvDocumentId"],
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness check",
        description: "Unauthenticated. Does not use the `{ data, error }` envelope — returns a bare status object.",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: { type: "object", properties: { status: { type: "string", example: "ok" } } },
              },
            },
          },
        },
      },
    },

    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Create an account",
        description:
          "Creates an unverified User (no career profile is created automatically — those are only created explicitly) and emails a 6-digit confirmation code, valid for 15 minutes (the code is also in the subject line). No session is started: entering the code via POST /auth/verify-code signs the user in. Signing up again with an unconfirmed email replaces its pending password and sends a new code.",
        operationId: "registerUser",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } },
        },
        responses: {
          "201": dataResponse("Account created; confirmation email sent", {
            type: "object",
            properties: {
              verificationRequired: { type: "boolean", enum: [true] },
              email: { type: "string", format: "email" },
            },
            required: ["verificationRequired", "email"],
          }),
          "400": errorResponse(
            "VALIDATION_ERROR — malformed email or password under 8 characters; EMAIL_UNDELIVERABLE — the email's domain has no mail servers"
          ),
          "409": errorResponse("EMAIL_TAKEN — a verified account with this email already exists"),
        },
      },
    },

    "/auth/verify-code": {
      post: {
        tags: ["Auth"],
        summary: "Confirm an email address with its code",
        description:
          "Checks the 6-digit code from the confirmation email (spaces or dashes are ignored). Right: marks the email verified, spends the code, sets the refresh-token httpOnly cookie and returns an access token. Each code allows 5 wrong tries; guesses are also capped per IP (20 per 10 minutes, 100 a day). Unknown or already-verified emails get the same INVALID_CODE answer.",
        operationId: "verifyEmailCode",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { email: { type: "string", format: "email" }, code: { type: "string", example: "482913" } },
                required: ["email", "code"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Email confirmed and signed in", { $ref: "#/components/schemas/AuthResult" }),
          "400": errorResponse(
            "INVALID_CODE — wrong code (the message says how many tries are left); CODE_EXPIRED — older than 15 minutes; TOO_MANY_ATTEMPTS — 5 wrong tries, a new code is needed"
          ),
          "429": errorResponse("RATE_LIMITED — too many guesses from this IP; see the Retry-After header"),
        },
      },
    },

    "/auth/verify-email": {
      post: {
        tags: ["Auth"],
        summary: "Confirm an email address (legacy link)",
        description:
          "Spends the single-use token from a confirmation link in an email sent before codes replaced links, marks the email verified, sets the refresh-token httpOnly cookie and returns an access token. New emails carry a code: see POST /auth/verify-code.",
        operationId: "verifyEmail",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
            },
          },
        },
        responses: {
          "200": dataResponse("Email confirmed and signed in", { $ref: "#/components/schemas/AuthResult" }),
          "400": errorResponse("INVALID_VERIFICATION_TOKEN — unknown, already used or expired token"),
        },
      },
    },

    "/auth/resend-verification": {
      post: {
        tags: ["Auth"],
        summary: "Resend the confirmation email",
        description:
          "Sends a new confirmation code (earlier codes stop working) if the email belongs to an unconfirmed account. Answers the same either way. Limited to one request a minute and five an hour, per email and per IP.",
        operationId: "resendVerification",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] },
            },
          },
        },
        responses: {
          "200": dataResponse("Request accepted", {
            type: "object",
            properties: { sent: { type: "boolean" } },
            required: ["sent"],
          }),
          "429": errorResponse("RATE_LIMITED — too many requests; see the Retry-After header"),
        },
      },
    },

    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in",
        description: "Verifies credentials, sets the refresh-token httpOnly cookie, and returns an access token.",
        operationId: "loginUser",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
        },
        responses: {
          "200": dataResponse("Login succeeded", { $ref: "#/components/schemas/AuthResult" }),
          "400": errorResponse("VALIDATION_ERROR — malformed email or empty password"),
          "401": errorResponse("INVALID_CREDENTIALS — email not found or password incorrect"),
          "403": errorResponse("EMAIL_NOT_VERIFIED — correct password, but the email hasn't been confirmed yet"),
        },
      },
    },

    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate a new access token",
        description:
          "Reads the refresh-token httpOnly cookie (sent automatically by the browser), rotates it (a new cookie with a fresh 30-day expiry replaces the old one), and issues a new 15-minute access token. Call this once on app load to silently restore a session, and again whenever a request comes back 401. Replaying an already-rotated refresh token revokes all of the user's sessions.",
        operationId: "refreshAccessToken",
        responses: {
          "200": dataResponse("New access token issued", {
            type: "object",
            properties: { accessToken: { type: "string" } },
            required: ["accessToken"],
          }),
          "401": errorResponse("UNAUTHORIZED — refresh cookie missing, invalid, expired, revoked, or the user no longer exists"),
        },
      },
    },

    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get the current user",
        description: "Resolves the authenticated user from the access token. Typically called right after refresh to repopulate user state on app load.",
        operationId: "getCurrentUser",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Current user", { $ref: "#/components/schemas/User" }),
          "401": errorResponse("UNAUTHORIZED — missing/invalid/expired access token, or the user no longer exists"),
        },
      },
      delete: {
        tags: ["Auth"],
        summary: "Delete the current account",
        description:
          "Permanently deletes the user and all their profiles, CVs, imports and payment records. Re-confirms identity with `password` (accounts with one) or `confirmEmail` (Google-only accounts). Refused while a Polar subscription is still set to renew.",
        operationId: "deleteCurrentUser",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  password: { type: "string" },
                  confirmEmail: { type: "string", format: "email" },
                  reason: {
                    type: "string",
                    enum: ["got_the_job", "not_useful", "too_expensive", "poor_results", "privacy", "other_service", "other"],
                    description: "Optional. Stored as feedback without any link to the account.",
                  },
                  comment: { type: "string", maxLength: 1000 },
                },
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Account deleted", {
            type: "object",
            properties: { success: { type: "boolean", example: true } },
            required: ["success"],
          }),
          "400": errorResponse("WRONG_PASSWORD | CONFIRMATION_MISMATCH | VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "409": errorResponse("ACTIVE_SUBSCRIPTION — cancel the renewing Polar subscription first"),
        },
      },
    },

    "/occupations": {
      get: {
        tags: ["Auth"],
        summary: "Search the occupation catalog",
        description:
          "Typeahead for onboarding and Account settings. Titles starting with `q` rank first, then word matches, then keyword matches. Empty `q` returns the first entries alphabetically.",
        operationId: "searchOccupations",
        security: bearerAuth,
        parameters: [
          { name: "q", in: "query", schema: { type: "string", maxLength: 80 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
        ],
        responses: {
          "200": dataResponse("Matching occupations", {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, title: { type: "string" }, category: { type: "string" } },
              required: ["id", "title", "category"],
            },
          }),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/auth/me/onboarding/from-cv": {
      post: {
        tags: ["Auth"],
        summary: "Fill account details from a first CV",
        description:
          "For someone who signed up in the middle of a /try flow (surface \"try\") or uploaded their CV during onboarding (surface \"dashboard\"): fills the account's empty first/last name, phone and profession from the CV's personal section — never over values already set — and records `flow` as their signup intent. Onboarding counts as completed once name and profession are there.",
        operationId: "onboardingFromCv",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  cvDocumentId: { type: "string", format: "uuid" },
                  flow: { type: "string", enum: ["create", "tailor", "improve"] },
                  surface: { type: "string", enum: ["try", "dashboard"] },
                  signupAttribution: { type: "object", description: "First-touch utm/referrer/landing data; kept only the first time." },
                },
                required: ["cvDocumentId", "flow", "surface"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("The updated user", { $ref: "#/components/schemas/User" }),
          "400": errorResponse("VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
        },
      },
    },

    "/me/activation": {
      get: {
        tags: ["Activation"],
        summary: "Getting-started checklist and one-time prompts",
        description:
          "Which first steps the user has done (a first CV, a PDF download, a career profile, a tailored CV), whether career profiles are available to them (the checklist's last step is a tailored CV otherwise), and the state of each one-time prompt (checklist, tour_offer, cv_rating, cv_rating_exit, cv_rating_download).",
        operationId: "getActivation",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Activation state", {
            type: "object",
            properties: {
              steps: {
                type: "object",
                properties: {
                  firstCv: { type: "boolean" },
                  pdfDownloaded: { type: "boolean" },
                  careerProfile: { type: "boolean" },
                  tailoredCv: { type: "boolean" },
                },
              },
              canUseCareerProfiles: { type: "boolean" },
              prompts: {
                type: "object",
                description: "Keyed by prompt (checklist, tour_offer, cv_rating, cv_rating_exit, cv_rating_download); null when never shown.",
                additionalProperties: {
                  type: "object",
                  nullable: true,
                  properties: {
                    shownAt: { type: "string", format: "date-time", nullable: true },
                    dismissedAt: { type: "string", format: "date-time", nullable: true },
                    completedAt: { type: "string", format: "date-time", nullable: true },
                  },
                },
              },
            },
          }),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/me/prompts/{key}": {
      post: {
        tags: ["Activation"],
        summary: "Record a one-time prompt being shown, dismissed or completed",
        description: "Only the first time of each action is kept (showing it again doesn't move shownAt).",
        operationId: "updatePrompt",
        security: bearerAuth,
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", enum: ["checklist", "tour_offer", "cv_rating", "cv_rating_exit", "cv_rating_download"] } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { action: { type: "string", enum: ["shown", "dismissed", "completed"] } }, required: ["action"] },
            },
          },
        },
        responses: {
          "200": dataResponse("The prompt's state", { type: "object" }),
          "400": errorResponse("VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("UNKNOWN_PROMPT"),
        },
      },
    },

    "/feedback": {
      post: {
        tags: ["Activation"],
        summary: "Rate a CV or an AI draft",
        description:
          "`cv_rating`: 1–5 (optional `trigger`: editor_exit | download), asked after the first CV and after a download until they've rated. `ai_draft`: thumbs up (1) or down (-1) on a CV a flow just wrote, with an optional reason (wrong_details, too_generic, missing_experience, bad_wording, too_long, other). Answering again for the same CV replaces the earlier answer. 10 a minute per user.",
        operationId: "sendFeedback",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["cv_rating", "ai_draft"] },
                  rating: { type: "integer" },
                  reason: { type: "string" },
                  comment: { type: "string", maxLength: 1000 },
                  cvDocumentId: { type: "string", format: "uuid" },
                  flowType: { type: "string", enum: ["create", "tailor", "improve"] },
                },
                required: ["kind", "rating"],
              },
            },
          },
        },
        responses: {
          "201": dataResponse("Recorded", { type: "object", properties: { id: { type: "string" } } }),
          "400": errorResponse("VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
          "429": errorResponse("RATE_LIMITED"),
        },
      },
    },

    "/events": {
      post: {
        tags: ["Activation"],
        summary: "Record a UI event (signed in)",
        description:
          "Allow-listed events only, each with fixed props: onboarding_step_viewed {step}, onboarding_skipped {step}, checklist_item_clicked {item}, tour_started {from}, tour_finished {steps}, try_started {flow}, try_signup_prompted {flow}. 60 a minute per user.",
        operationId: "recordEvent",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, props: { type: "object" }, anonymousId: { type: "string", format: "uuid" } },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "202": dataResponse("Recorded", { type: "object", properties: { recorded: { type: "boolean" } } }),
          "400": errorResponse("VALIDATION_ERROR | INVALID_EVENT"),
          "401": errorResponse("UNAUTHORIZED"),
          "429": errorResponse("RATE_LIMITED"),
        },
      },
    },

    "/events/anonymous": {
      post: {
        tags: ["Activation"],
        summary: "Record a UI event before sign-up",
        description: "No account: only try_started and try_signup_prompted, with the browser's random `anonymousId`. 30 per 10 minutes per IP.",
        operationId: "recordAnonymousEvent",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, props: { type: "object" }, anonymousId: { type: "string", format: "uuid" } },
                required: ["name", "anonymousId"],
              },
            },
          },
        },
        responses: {
          "202": dataResponse("Recorded", { type: "object", properties: { recorded: { type: "boolean" } } }),
          "400": errorResponse("VALIDATION_ERROR | INVALID_EVENT"),
          "401": errorResponse("UNAUTHORIZED — this event needs an account"),
          "429": errorResponse("RATE_LIMITED"),
        },
      },
    },

    "/auth/me/email": {
      post: {
        tags: ["Auth"],
        summary: "Start changing the account email",
        description:
          "Emails a 6-digit code (valid 15 minutes) to `newEmail`; the account's email changes only when POST /auth/me/email/confirm gets that code. `password` is required when the account has one. Replaces any pending change. Send limits: 1 code a minute and 5 an hour per address (shared with sign-up codes), 3 a minute and 5 an hour per account. PATCH /auth/me no longer changes the email (EMAIL_CHANGE_NEEDS_VERIFICATION).",
        operationId: "startEmailChange",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { newEmail: { type: "string", format: "email" }, password: { type: "string" } },
                required: ["newEmail"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Code sent to the new address", {
            type: "object",
            properties: { pendingEmail: { type: "string", format: "email" } },
            required: ["pendingEmail"],
          }),
          "400": errorResponse("WRONG_PASSWORD | SAME_EMAIL | EMAIL_UNDELIVERABLE | VALIDATION_ERROR"),
          "409": errorResponse("EMAIL_TAKEN — another account uses this email"),
          "429": errorResponse("RATE_LIMITED — see the Retry-After header"),
        },
      },
      delete: {
        tags: ["Auth"],
        summary: "Cancel a pending email change",
        operationId: "cancelEmailChange",
        security: bearerAuth,
        responses: { "200": dataResponse("Cancelled", { type: "object", properties: { success: { type: "boolean" } } }) },
      },
    },

    "/auth/me/email/resend": {
      post: {
        tags: ["Auth"],
        summary: "Send a new code for the pending email change",
        description: "Earlier codes stop working. Same send limits as starting the change.",
        operationId: "resendEmailChange",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Code sent", {
            type: "object",
            properties: { pendingEmail: { type: "string", format: "email" } },
            required: ["pendingEmail"],
          }),
          "400": errorResponse("NO_PENDING_CHANGE"),
          "429": errorResponse("RATE_LIMITED"),
        },
      },
    },

    "/auth/me/email/confirm": {
      post: {
        tags: ["Auth"],
        summary: "Confirm the email change with its code",
        description:
          "Moves the account to the pending address and emails a notice to the old one. 5 wrong tries per code; guesses are also capped per IP and per account. An unconfirmed sign-up holding the address is removed (it never proved the address).",
        operationId: "confirmEmailChange",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { code: { type: "string", example: "482913" } }, required: ["code"] },
            },
          },
        },
        responses: {
          "200": dataResponse("Email changed", { $ref: "#/components/schemas/User" }),
          "400": errorResponse("INVALID_CODE | CODE_EXPIRED | TOO_MANY_ATTEMPTS | NO_PENDING_CHANGE"),
          "409": errorResponse("EMAIL_TAKEN — someone claimed the address since the code was sent"),
          "429": errorResponse("RATE_LIMITED"),
        },
      },
    },

    "/auth/password": {
      post: {
        tags: ["Auth"],
        summary: "Change or set the password",
        description:
          "Changes the password (`currentPassword` required) or sets a first one on a Google-only account. Revokes every other session and issues a fresh refresh cookie for this device.",
        operationId: "changePassword",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } },
                required: ["newPassword"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Password updated", { $ref: "#/components/schemas/User" }),
          "400": errorResponse("WRONG_PASSWORD | VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Log out",
        description: "Revokes the current refresh token server-side and clears its cookie. Does not require an access token.",
        operationId: "logoutUser",
        responses: {
          "200": dataResponse("Logged out", {
            type: "object",
            properties: { success: { type: "boolean", example: true } },
            required: ["success"],
          }),
        },
      },
    },

    "/auth/logout-all": {
      post: {
        tags: ["Auth"],
        summary: "Log out of every device",
        description:
          "Revokes every refresh token (session) the user has and clears the current cookie. Already-issued access tokens remain valid until their 15-minute expiry.",
        operationId: "logoutAllSessions",
        security: bearerAuth,
        responses: {
          "200": dataResponse("All sessions revoked", {
            type: "object",
            properties: { success: { type: "boolean", example: true } },
            required: ["success"],
          }),
          "401": errorResponse("UNAUTHORIZED — missing or invalid access token"),
        },
      },
    },

    "/profiles": {
      post: {
        tags: ["Profiles"],
        summary: "Create a career profile",
        description: "One profile per role: a title that resolves to the same roleKey as an existing profile is rejected with 409 PROFILE_ROLE_EXISTS (the error carries existingProfileId).",
        operationId: "createProfile",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProfileRequest" } } },
        },
        responses: {
          "201": dataResponse("Profile created", { $ref: "#/components/schemas/CareerProfileDetail" }),
          "400": errorResponse("VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "409": errorResponse("PROFILE_ROLE_EXISTS — the user already has a profile for this role"),
          "413": errorResponse("PROFILE_TOO_LARGE"),
        },
      },
      get: {
        tags: ["Profiles"],
        summary: "List the current user's career profiles",
        description: "Most recently updated first. Open on every plan.",
        operationId: "listProfiles",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Profiles for the current user", {
            type: "array",
            items: { $ref: "#/components/schemas/CareerProfileListItem" },
          }),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/profiles/suggest-for-cv": {
      post: {
        tags: ["Profiles"],
        summary: "Which profile a new CV belongs to",
        description:
          "Read-only. Matches the CV's role to the user's profiles — same roleKey, then same occupation, then (only if both find nothing) a small cached AI classification — and previews what saving would change. Returns { roleTitle, match: { profileId, title, via, preview } | null, related: [{ profileId, title }], newProfilePreview, linkedProfileId, autoSync }. Related roles are suggestions only; nothing is merged into them automatically.",
        operationId: "suggestProfileForCv",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { cvDocumentId: { type: "string" }, factsOnly: { type: "boolean" } },
                required: ["cvDocumentId"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Suggestion", { type: "object" }),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
        },
      },
    },

    "/profiles/wording/preview": {
      post: {
        tags: ["Profiles"],
        summary: "Improved wording to offer back to a profile (Enhance)",
        description:
          "Read-only. For the profile linked to the CV (or to sourceCvId, or the role match), lists entries whose wording in the improved CV differs from the profile: { profile, reason, proposals: [{ key, section, label, before, after, locked }] }. Nothing is offered for a job-tailored CV (reason \"tailored\") or when profile updates are off (\"updates_off\").",
        operationId: "previewCvWording",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { cvDocumentId: { type: "string" }, sourceCvId: { type: "string" } }, required: ["cvDocumentId"] },
            },
          },
        },
        responses: {
          "200": dataResponse("Proposals", { type: "object" }),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND or PROFILE_NOT_FOUND"),
        },
      },
    },

    "/profiles/{id}/wording": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      post: {
        tags: ["Profiles"],
        summary: "Save approved improved wording to a profile",
        description:
          "Applies only the approved proposal keys, recomputed from the stored CV (the client never sends text). Approved entries become locked (source \"enhance\"). Links the CV. Returns { profile, applied, changeId }.",
        operationId: "applyCvWording",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { cvDocumentId: { type: "string" }, version: { type: "integer" }, keys: { type: "array", items: { type: "string" } } },
                required: ["cvDocumentId", "version", "keys"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Applied", { type: "object" }),
          "400": errorResponse("WORDING_TAILORED — the CV was written for a job"),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED"),
          "404": errorResponse("PROFILE_NOT_FOUND or CV_DOCUMENT_NOT_FOUND"),
          "409": errorResponse("PROFILE_VERSION_CONFLICT"),
        },
      },
    },

    "/profiles/from-cv": {
      post: {
        tags: ["Profiles"],
        summary: "Create a profile from a CV, or merge a CV into a profile",
        description:
          "Deterministic, no AI call. Merging only adds: new items are appended, empty fields filled and new bullets appended on unlocked items; locked (user-edited) and dismissed items are left alone. A CV generated against a job description contributes facts only, not its tailored wording. The CV is linked to the profile. Returns { profile, summary, created, changeId } — changeId (null when nothing changed or on create) can be passed to the revert endpoint to undo.",
        operationId: "profileFromCv",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProfileFromCvRequest" } } },
        },
        responses: {
          "200": dataResponse("Merged into the existing profile", { type: "object" }),
          "201": dataResponse("New profile created from the CV", { type: "object" }),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("PROFILE_NOT_FOUND or CV_DOCUMENT_NOT_FOUND"),
          "409": errorResponse("PROFILE_ROLE_EXISTS (creating) or PROFILE_VERSION_CONFLICT"),
        },
      },
    },

    "/profiles/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Profiles"],
        summary: "Get a career profile",
        description: "Content, linked CVs and recent change history. Open on every plan.",
        operationId: "getProfile",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Profile detail", { $ref: "#/components/schemas/CareerProfileDetail" }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("PROFILE_NOT_FOUND — no such profile, or it belongs to a different user"),
        },
      },
      patch: {
        tags: ["Profiles"],
        summary: "Edit a career profile",
        operationId: "updateProfile",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateProfileRequest" } } },
        },
        responses: {
          "200": dataResponse("Profile updated", { $ref: "#/components/schemas/CareerProfileDetail" }),
          "400": errorResponse("VALIDATION_ERROR"),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("PROFILE_NOT_FOUND"),
          "409": errorResponse("PROFILE_VERSION_CONFLICT — changed since loaded; or PROFILE_ROLE_EXISTS after a rename"),
          "413": errorResponse("PROFILE_TOO_LARGE"),
        },
      },
      delete: {
        tags: ["Profiles"],
        summary: "Delete a career profile",
        description: "Allowed on every plan. Linked CV documents are detached (profileId set to null), never deleted.",
        operationId: "deleteProfile",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Profile deleted", {
            type: "object",
            properties: { success: { type: "boolean", example: true } },
            required: ["success"],
          }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("PROFILE_NOT_FOUND"),
        },
      },
    },

    "/profiles/{id}/cv-content": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Profiles"],
        summary: "The profile as CV content",
        description: "Profile content in CVContent shape with the account's contact details filled in — the source for generating a CV from this profile. Returns { content, profileVersion }.",
        operationId: "getProfileCvContent",
        security: bearerAuth,
        responses: {
          "200": dataResponse("CV-shaped content", { type: "object" }),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("PROFILE_NOT_FOUND"),
        },
      },
    },

    "/profiles/{id}/changes/{changeId}/revert": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "changeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      post: {
        tags: ["Profiles"],
        summary: "Undo a profile change",
        description: "Restores the content as it was before that change. The revert is itself recorded and can be undone.",
        operationId: "revertProfileChange",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { version: { type: "integer" } }, required: ["version"] } } },
        },
        responses: {
          "200": dataResponse("Reverted", { $ref: "#/components/schemas/CareerProfileDetail" }),
          "400": errorResponse("PROFILE_CHANGE_NOT_REVERTIBLE — creation can't be undone"),
          "401": errorResponse("UNAUTHORIZED"),
          "402": errorResponse("PRO_REQUIRED — Career Profiles are a Pro feature"),
          "404": errorResponse("PROFILE_NOT_FOUND or PROFILE_CHANGE_NOT_FOUND"),
          "409": errorResponse("PROFILE_VERSION_CONFLICT"),
        },
      },
    },

    "/cv": {
      post: {
        tags: ["CV Documents"],
        summary: "Start a new CV draft",
        description:
          "Creates a CVDocument with empty content (empty personal object, empty arrays for list sections) and currentStep set to \"personal\".",
        operationId: "createCVDocument",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateCVDocumentRequest" } } },
        },
        responses: {
          "201": dataResponse("Draft created", { $ref: "#/components/schemas/CVDocument" }),
          "400": errorResponse("VALIDATION_ERROR — profileId missing or templateId not one of the allowed values"),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("PROFILE_NOT_FOUND — profileId does not belong to the current user"),
        },
      },
      get: {
        tags: ["CV Documents"],
        summary: "List CV documents for a profile",
        operationId: "listCVDocuments",
        security: bearerAuth,
        parameters: [
          {
            name: "profileId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Required. Documents are scoped to this profile and the current user.",
          },
        ],
        responses: {
          "200": dataResponse("Documents for the profile, newest first", {
            type: "array",
            items: { $ref: "#/components/schemas/CVDocument" },
          }),
          "400": errorResponse("VALIDATION_ERROR — profileId query parameter is required"),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/cv/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["CV Documents"],
        summary: "Get a CV document",
        operationId: "getCVDocument",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Document detail", { $ref: "#/components/schemas/CVDocument" }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND — no such document, or it belongs to a different user"),
        },
      },
      delete: {
        tags: ["CV Documents"],
        summary: "Delete a CV document",
        operationId: "deleteCVDocument",
        security: bearerAuth,
        responses: {
          "200": dataResponse("Document deleted", {
            type: "object",
            properties: { success: { type: "boolean", example: true } },
            required: ["success"],
          }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
        },
      },
    },

    "/cv/{id}/step/{stepName}": {
      patch: {
        tags: ["CV Documents"],
        summary: "Save one wizard step",
        description:
          "Updates only the named section of `content` (request body is `{ [stepName]: <that section's data> }`), validated against that section's shape alone — other sections are untouched. If this document's `currentStep` was `stepName`, it advances to the next step in the fixed sequence. `stepName` cannot be \"review\" (nothing to save there — use finalize instead).",
        operationId: "patchCVStep",
        security: bearerAuth,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          {
            name: "stepName",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: [
                "personal",
                "summary",
                "experience",
                "education",
                "skills",
                "certifications",
                "projects",
                "languages",
              ],
            },
            description: "One of the content-bearing wizard steps (all of WizardStep except \"review\").",
          },
        ],
        requestBody: {
          required: true,
          description:
            "A single-key object keyed by stepName, e.g. `{ \"experience\": [...] }` for stepName=experience or `{ \"summary\": \"...\" }` for stepName=summary.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Shape depends on stepName — see CVContent's matching property.",
                additionalProperties: true,
                example: {
                  experience: [
                    {
                      company: "Acme",
                      role: "Engineer",
                      start_date: "2023-01",
                      end_date: "present",
                      bullets: ["Built things"],
                    },
                  ],
                },
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Document with the section saved (and currentStep advanced if applicable)", {
            $ref: "#/components/schemas/CVDocument",
          }),
          "400": errorResponse(
            "INVALID_STEP — stepName is not a recognized step (or is \"review\"), or VALIDATION_ERROR — section data doesn't match that step's shape"
          ),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
        },
      },
    },

    "/cv/{id}/finalize": {
      post: {
        tags: ["CV Documents"],
        summary: "Finalize a CV document",
        description:
          "Validates the full document content: personal must be complete, experience must have >= 1 entry, and skills must have >= 1 entry; everything else may be empty. On success sets status to \"final\". On failure, responds 422 and lists exactly which fields are missing/invalid.",
        operationId: "finalizeCVDocument",
        security: bearerAuth,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": dataResponse("Document finalized", { $ref: "#/components/schemas/CVDocument" }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
          "422": errorResponse(
            "INCOMPLETE_DOCUMENT — required fields are missing or invalid; error.fields lists each one, e.g. [\"personal.email\", \"experience\", \"skills\"]"
          ),
        },
      },
    },

    "/templates": {
      get: {
        tags: ["Templates"],
        summary: "List CV templates",
        description: "Every template the backend can render, with the sections it shows in order. Public.",
        operationId: "listTemplates",
        responses: {
          "200": dataResponse("Templates", {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", example: "classic" },
                name: { type: "string" },
                description: { type: "string" },
                sections: { type: "array", items: { type: "string" } },
                isDefault: { type: "boolean" },
              },
              required: ["id", "name", "description", "sections", "isDefault"],
            },
          }),
        },
      },
    },

    "/templates/{id}/sample": {
      get: {
        tags: ["Templates"],
        summary: "Render a template with a fictional sample CV",
        description: "Preview-mode HTML for gallery thumbnails. Public.",
        operationId: "getTemplateSample",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": dataResponse("Rendered HTML", {
            type: "object",
            properties: { html: { type: "string" } },
            required: ["html"],
          }),
          "404": errorResponse("TEMPLATE_NOT_FOUND"),
        },
      },
    },

    "/cv/preview": {
      post: {
        tags: ["Rendering"],
        summary: "Render unsaved CV content to preview HTML",
        description:
          "Renders the given (partial) CV content with a template, exactly as the PDF would print it, and returns a self-contained HTML document for an iframe. Legacy ids (e.g. \"tech\") resolve to the default template. Nothing is persisted.",
        operationId: "previewCv",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { templateId: { type: "string" }, content: { type: "object" } },
                required: ["templateId", "content"],
              },
            },
          },
        },
        responses: {
          "200": dataResponse("Rendered HTML", {
            type: "object",
            properties: { html: { type: "string" } },
            required: ["html"],
          }),
          "400": errorResponse("VALIDATION_ERROR or INVALID_TEMPLATE"),
          "401": errorResponse("UNAUTHORIZED"),
        },
      },
    },

    "/cv/{id}/download": {
      get: {
        tags: ["Rendering"],
        summary: "Render and download a finalized CV as PDF",
        description:
          "Requires the document's status to be \"final\" (finalize it first). Renders the Handlebars template matching templateId to PDF with headless Chromium on every request and returns it directly — nothing is stored server-side, so the PDF always reflects the latest content. Does not use the `{ data, error } ` envelope on success — the response body is the raw PDF bytes with `Content-Type: application/pdf`. Error responses still use the envelope.",
        operationId: "downloadCVDocument",
        security: bearerAuth,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "The rendered PDF file",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          "401": errorResponse("UNAUTHORIZED"),
          "400": errorResponse("DOCUMENT_NOT_FINAL — finalize the document first"),
          "404": errorResponse("CV_DOCUMENT_NOT_FOUND"),
        },
      },
    },

    "/imports": {
      post: {
        tags: ["Imports"],
        summary: "Upload a CV file and extract its text",
        description:
          "Multipart upload, field name \"file\". Accepted types: pdf, docx, png, jpg, jpeg (max size from server's MAX_UPLOAD_MB). Extracts raw text deterministically, no AI: PDF text layers via pdf.js in reading order (two-column layouts read column by column, link targets kept), OCR (tesseract.js) for scanned PDF pages and images, DOCX XML including headers/footers, text boxes and hyperlinks. Best-effort-guesses personal.full_name/email/phone/links only (contact fields read with low OCR confidence are left out); experience/education/skills are never guessed. Always returns 201 with the CVImport row, whose `status` is \"complete\" or \"failed\" depending on whether extraction succeeded.",
        operationId: "createImport",
        security: bearerAuth,
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
                required: ["file"],
              },
            },
          },
        },
        responses: {
          "201": dataResponse("Import created (check status for extraction outcome)", {
            $ref: "#/components/schemas/CVImport",
          }),
          "400": errorResponse("NO_FILE — no file was uploaded, or UNSUPPORTED_FILE_TYPE — extension not in pdf/docx/png/jpg/jpeg"),
          "401": errorResponse("UNAUTHORIZED"),
          
          "413": errorResponse("FILE_TOO_LARGE — exceeds the server's MAX_UPLOAD_MB limit"),
        },
      },
    },

    "/imports/{id}": {
      get: {
        tags: ["Imports"],
        summary: "Get an import's full detail",
        description: "Includes rawText, for a review screen where the user copies details into a draft manually.",
        operationId: "getImport",
        security: bearerAuth,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": dataResponse("Import detail", { $ref: "#/components/schemas/CVImport" }),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("IMPORT_NOT_FOUND"),
        },
      },
    },

    "/imports/{id}/apply": {
      post: {
        tags: ["Imports"],
        summary: "Apply an import's extracted data to a CV draft",
        description:
          "Merges this import's extractedData into the target CVDocument's content, field by field, only where the draft's existing field is currently empty — it never overwrites data the user already entered. Also links this import to that document.",
        operationId: "applyImport",
        security: bearerAuth,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApplyImportRequest" } } },
        },
        responses: {
          "200": dataResponse("The CV document after merging", { $ref: "#/components/schemas/CVDocument" }),
          "400": errorResponse("VALIDATION_ERROR — cvDocumentId missing"),
          "401": errorResponse("UNAUTHORIZED"),
          "404": errorResponse("IMPORT_NOT_FOUND, or CV_DOCUMENT_NOT_FOUND — cvDocumentId does not belong to the current user"),
        },
      },
    },
  },
};
