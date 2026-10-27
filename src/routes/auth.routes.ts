import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "../db/client";
import { allowedOrigins, env } from "../config/env";
import {
  registerSchema,
  loginSchema,
  googleAuthSchema,
  verifyEmailSchema,
  verifyCodeSchema,
  resendVerificationSchema,
  changeEmailSchema,
  confirmEmailChangeSchema,
  updateProfileSchema,
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  onboardingFromCvSchema,
} from "../schemas/auth.schema";
import { hashPassword, comparePassword } from "../services/auth.service";
import { signAccessToken } from "../services/token.service";
import {
  REFRESH_TOKEN_TTL_SECONDS,
  createSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
} from "../services/session.service";
import {
  type GoogleProfile,
  verifyGoogleIdToken,
  isGoogleRedirectConfigured,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
} from "../services/google.service";
import {
  consumeVerificationToken,
  issueVerificationCode,
  takeResendSlot,
  verifyEmailCode,
} from "../services/emailVerification.service";
import { createRateLimiter } from "../utils/rate-limit";
import {
  EmailChangeError,
  cancelEmailChange,
  confirmEmailChange,
  pendingEmailChange,
  startEmailChange,
} from "../services/emailChange.service";
import { syncPolarCustomerEmail } from "../services/polar/customer-sync.service";
import { ACCOUNT_SUSPENDED_MESSAGE, requireAuth } from "../middleware/auth.middleware";
import { canDomainReceiveMail } from "../utils/email-domain";
import { sendError } from "../utils/http-error";
import { resolveProfessions, withMainProfession } from "../services/professions.service";
import { formatPersonName } from "../utils/person-name";
import { getSettings } from "../services/settings.service";
import { resetPasswordWithToken, sendPasswordResetEmail } from "../services/passwordReset.service";
import { deleteUserAccount, hasRenewingPolarSubscription } from "../services/accountDeletion.service";
import { trackActiveDay, trackEvent } from "../services/events.service";
import { fillAccountFromCv, OnboardingCvNotFoundError } from "../services/onboarding.service";
import { recordDeletionFeedback } from "../services/feedback.service";

const REGISTRATION_CLOSED_MESSAGE = "New sign-ups are paused right now. Please try again later.";

class RegistrationClosedError extends Error {}

function isSuspended(user: Pick<User, "status">): boolean {
  return user.status === "SUSPENDED";
}

// Sign-in bookkeeping for the admin's "last login / last active" columns.
export async function markSignedIn(userId: string) {
  const now = new Date();
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: now, lastActiveAt: now } }).catch(() => {});
  trackActiveDay(userId, now);
}

// The account became usable for the first time (email confirmed, or a first
// Google sign-in). Counted once per account.
function trackAccountCreated(userId: string, method: "password" | "google") {
  trackEvent("account_created", userId, { method }, `account_created:${userId}`);
}

// Refreshes run every ~15 minutes while someone uses the app; recording at
// most one write per few minutes keeps "last active" useful without a write
// on every request.
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
async function markActive(userId: string) {
  const cutoff = new Date(Date.now() - ACTIVITY_WRITE_INTERVAL_MS);
  const { count } = await prisma.user
    .updateMany({
      where: { id: userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: cutoff } }] },
      data: { lastActiveAt: new Date() },
    })
    .catch(() => ({ count: 0 }));
  // Same cadence for the daily "active" event (one row per day; repeats are skipped).
  if (count > 0) trackActiveDay(userId);
}

const REFRESH_COOKIE_NAME = "refreshToken";
const GOOGLE_STATE_COOKIE_NAME = "googleOAuthState";
const GOOGLE_STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_CALLBACK_PATH = "/api/v1/auth/google/callback";

// See REFRESH_COOKIE_SAMESITE in config/env.ts. "none" needs Secure, which
// browsers only honour over https — so it's for production only.
const REFRESH_COOKIE_SAMESITE = env.REFRESH_COOKIE_SAMESITE ?? (env.NODE_ENV === "production" ? "none" : "lax");

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || REFRESH_COOKIE_SAMESITE === "none",
    sameSite: REFRESH_COOKIE_SAMESITE,
    path: "/",
  } as const;
}

export function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE_NAME, token, { ...refreshCookieOptions(), maxAge: REFRESH_TOKEN_TTL_SECONDS });
}

// Cleared with the same attributes it was set with: a browser ignores a
// cross-site Set-Cookie whose SameSite/Secure don't allow it, which would
// leave the old cookie in place.
function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

// The refresh and logout endpoints act on the cookie alone (no bearer token),
// so with a cross-site cookie they only take requests from the frontend's own
// origins. Requests without an Origin header (same-origin GETs, server tools,
// tests) aren't from another site's page.
function isAllowedCookieOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.includes(origin);
}

// The user shape every auth endpoint returns. hasPassword / hasGoogle tell the
// settings page which sign-in methods exist: a Google-only account can set a
// first password, and account deletion re-confirms with whichever one exists.
function toApiUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    occupationTitle: user.occupationTitle,
    occupationId: user.occupationId,
    // Accounts from before the list existed still have their one profession.
    professions: user.professions.length ? user.professions : user.occupationTitle ? [user.occupationTitle] : [],
    onboardingCompleted: !!user.onboardingCompletedAt,
    signupIntent: user.signupIntent,
    careerStage: user.careerStage,
    acquisitionSource: user.acquisitionSource,
    acquisitionDetail: user.acquisitionDetail,
    signupSurface: user.signupSurface,
    profileAutoSync: user.profileAutoSync,
    hasPassword: !!user.passwordHash,
    hasGoogle: !!user.googleId,
    createdAt: user.createdAt.toISOString(),
  };
}

// Signs in the Google account's user: matched by Google ID first, then linked
// to an existing account with the same (Google-verified) email, else created.
// Google has verified the email, so the account counts as verified too.
async function findOrCreateGoogleUser(profile: GoogleProfile): Promise<User> {
  const user = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (user) {
    return user.emailVerifiedAt
      ? user
      : prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }

  const existingByEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (existingByEmail) {
    if (existingByEmail.emailVerifiedAt) {
      return prisma.user.update({
        where: { id: existingByEmail.id },
        data: { googleId: profile.googleId },
      });
    }
    // An unconfirmed password sign-up for this email may have been made by
    // someone else. Its password was never proven to belong to the email's
    // owner, so drop it and its pending links rather than let it in.
    const [, linked] = await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({ where: { userId: existingByEmail.id } }),
      prisma.user.update({
        where: { id: existingByEmail.id },
        data: { googleId: profile.googleId, passwordHash: null, emailVerifiedAt: new Date() },
      }),
    ]);
    return linked;
  }

  if (!(await getSettings()).platform.registrationEnabled) {
    throw new RegistrationClosedError();
  }

  const created = await prisma.user.create({
    data: {
      email: profile.email,
      googleId: profile.googleId,
      fullName: profile.fullName ? formatPersonName(profile.fullName) : profile.fullName,
      emailVerifiedAt: new Date(),
    },
  });
  trackAccountCreated(created.id, "google");
  return created;
}

// Emails a fresh confirmation link unless this address was sent one too
// recently. Failures are logged, not thrown: the account exists either way and
// the user can ask for another link.
async function issueVerificationEmail(app: FastifyInstance, user: User): Promise<void> {
  if (!(await takeResendSlot([`email:${user.email.toLowerCase()}`])).ok) return;
  try {
    await issueVerificationCode(user);
  } catch (err) {
    app.log.error({ err, userId: user.id }, "Failed to send verification email");
  }
}

// Change-email codes an account may request. Looser per minute than the
// per-address limit, so fixing a typo in the new address (a different
// address) isn't blocked; the hourly cap still bounds it.
const emailChangeAccountLimiter = createRateLimiter("email-change", [
  { ms: 60 * 1000, max: 3 },
  { ms: 60 * 60 * 1000, max: 5 },
]);

// Emails a code for changing `user`'s email to `newEmail`. Two limits: the
// account's (above), and the address's — one a minute, five an hour, shared
// with sign-up codes, so no address can be flooded.
async function sendEmailChangeCode(user: User, newEmail: string, reply: FastifyReply) {
  // Address first: a send it refuses then doesn't use up one of the account's.
  const addressSlot = await takeResendSlot([`email:${newEmail.toLowerCase()}`]);
  const slot = addressSlot.ok ? await emailChangeAccountLimiter.take([`email-change:${user.id}`]) : addressSlot;
  if (!slot.ok) {
    reply.header("Retry-After", String(slot.retryAfterSeconds));
    return reply.code(429).send({
      data: null,
      error: {
        code: "RATE_LIMITED",
        message: `Please wait ${slot.retryAfterSeconds} seconds before requesting another code.`,
        retryAfterSeconds: slot.retryAfterSeconds,
      },
    });
  }
  if (!(await canDomainReceiveMail(newEmail))) {
    return sendError(reply, 400, "EMAIL_UNDELIVERABLE", "This email address can't receive mail. Check it for typos.");
  }
  try {
    await startEmailChange(user, newEmail);
  } catch (err) {
    if (err instanceof EmailChangeError) {
      return sendError(reply, err.code === "EMAIL_TAKEN" ? 409 : 400, err.code, err.message);
    }
    return sendError(reply, 502, "EMAIL_FAILED", "We couldn't send the code. Please try again.");
  }
  return reply.send({ data: { pendingEmail: newEmail }, error: null });
}

// Code guesses per IP, on top of the per-code limit: enough for typos across
// a few resends, far too few to guess a million-code space.
const codeAttemptLimiter = createRateLimiter("code-attempt", [
  { ms: 10 * 60 * 1000, max: 20 },
  { ms: 24 * 60 * 60 * 1000, max: 100 },
]);

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Redirect-flow failures can't return JSON — the browser is mid-navigation —
// so they land back on the login page with an error code to show.
function redirectToFrontendError(reply: FastifyReply, code: string) {
  return reply.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(code)}`);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/v1/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const { email, password } = parsed.data;

    if (!(await getSettings()).platform.registrationEnabled) {
      return sendError(reply, 403, "REGISTRATION_CLOSED", REGISTRATION_CLOSED_MESSAGE);
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerifiedAt) {
      return sendError(reply, 409, "EMAIL_TAKEN", "An account with this email already exists");
    }

    if (!(await canDomainReceiveMail(email))) {
      return sendError(reply, 400, "EMAIL_UNDELIVERABLE", "This email address can't receive mail. Check it for typos.");
    }

    const passwordHash = await hashPassword(password);

    // Signing up again before confirming replaces the pending password: until
    // the email is confirmed, nobody has proven they own it.
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: { passwordHash } })
      : await prisma.user.create({ data: { email, passwordHash } });
    if (!existing) trackEvent("signup_started", user.id, { method: "password" });

    await issueVerificationEmail(app, user);

    // No session yet — the confirmation link signs the user in.
    return reply.code(201).send({
      data: { verificationRequired: true, email: user.email },
      error: null,
    });
  });

  // The 6-digit code from the confirmation email, typed back in: confirms the
  // email and signs the user in. Each code allows a few wrong tries (counted
  // in the database); this caps guessing across codes and accounts per IP.
  app.post("/api/v1/auth/verify-code", async (request, reply) => {
    const parsed = verifyCodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const slot = await codeAttemptLimiter.take([`ip:${request.ip}`]);
    if (!slot.ok) {
      reply.header("Retry-After", String(slot.retryAfterSeconds));
      return sendError(reply, 429, "RATE_LIMITED", `Too many tries. Please wait ${slot.retryAfterSeconds} seconds.`);
    }

    const result = await verifyEmailCode(parsed.data.email, parsed.data.code);
    if (!result.ok) {
      if (result.reason === "expired") {
        return sendError(reply, 400, "CODE_EXPIRED", "This code has expired. Send a new one.");
      }
      if (result.reason === "too_many_attempts") {
        return sendError(reply, 400, "TOO_MANY_ATTEMPTS", "Too many wrong tries. Send a new code.");
      }
      return sendError(
        reply,
        400,
        "INVALID_CODE",
        `That code isn't right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`
      );
    }

    if (isSuspended(result.user)) {
      return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
    }

    const accessToken = signAccessToken(result.user.id);
    setRefreshCookie(reply, await createSession(result.user.id));
    await markSignedIn(result.user.id);
    trackAccountCreated(result.user.id, "password");

    return reply.send({
      data: { user: toApiUser(result.user), accessToken },
      error: null,
    });
  });

  // Confirmation links from emails sent before codes, on the frontend's
  // /verify-email page. New emails carry a code instead. Opening the link
  // alone never confirms (email scanners open links too).
  app.post("/api/v1/auth/verify-email", async (request, reply) => {
    const parsed = verifyEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await consumeVerificationToken(parsed.data.token);
    if (!user) {
      return sendError(
        reply,
        400,
        "INVALID_VERIFICATION_TOKEN",
        "This confirmation link is invalid or has expired. Request a new one."
      );
    }

    if (isSuspended(user)) {
      return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
    }

    const accessToken = signAccessToken(user.id);
    setRefreshCookie(reply, await createSession(user.id));
    await markSignedIn(user.id);
    trackAccountCreated(user.id, "password");

    return reply.send({
      data: { user: toApiUser(user), accessToken },
      error: null,
    });
  });

  // Always answers the same way whether or not the email has an unconfirmed
  // account, so it can't be used to probe which emails are registered.
  app.post("/api/v1/auth/resend-verification", async (request, reply) => {
    const parsed = resendVerificationSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const { email } = parsed.data;
    const slot = await takeResendSlot([`email:${email.toLowerCase()}`, `ip:${request.ip}`]);
    if (!slot.ok) {
      reply.header("Retry-After", String(slot.retryAfterSeconds));
      // retryAfterSeconds lets the frontend count the button down.
      return reply.code(429).send({
        data: null,
        error: {
          code: "RATE_LIMITED",
          message: `Please wait ${slot.retryAfterSeconds} seconds before requesting another email.`,
          retryAfterSeconds: slot.retryAfterSeconds,
        },
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.passwordHash) {
      try {
        await issueVerificationCode(user);
      } catch (err) {
        request.log.error({ err, userId: user.id }, "Failed to resend verification email");
      }
    }

    return reply.send({ data: { sent: true }, error: null });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || !(await comparePassword(password, user.passwordHash))) {
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    // Checked only after the password, so it reveals nothing to a stranger.
    if (!user.emailVerifiedAt) {
      return sendError(reply, 403, "EMAIL_NOT_VERIFIED", "Confirm your email before signing in. Check your inbox for the link.");
    }

    if (isSuspended(user)) {
      return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
    }

    const accessToken = signAccessToken(user.id);
    setRefreshCookie(reply, await createSession(user.id));
    await markSignedIn(user.id);

    return reply.send({
      data: { user: toApiUser(user), accessToken },
      error: null,
    });
  });

  app.post("/api/v1/auth/google", async (request, reply) => {
    const parsed = googleAuthSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    let profile;
    try {
      profile = await verifyGoogleIdToken(parsed.data.idToken);
    } catch {
      return sendError(reply, 401, "INVALID_GOOGLE_TOKEN", "Google sign-in could not be verified");
    }

    if (!profile.emailVerified) {
      return sendError(reply, 401, "EMAIL_NOT_VERIFIED", "Google account email is not verified");
    }

    let user: User;
    try {
      user = await findOrCreateGoogleUser(profile);
    } catch (err) {
      if (err instanceof RegistrationClosedError) {
        return sendError(reply, 403, "REGISTRATION_CLOSED", REGISTRATION_CLOSED_MESSAGE);
      }
      throw err;
    }

    if (isSuspended(user)) {
      return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
    }

    const accessToken = signAccessToken(user.id);
    setRefreshCookie(reply, await createSession(user.id));
    await markSignedIn(user.id);

    return reply.send({
      data: { user: toApiUser(user), accessToken },
      error: null,
    });
  });

  // Redirect-based Google sign-in (authorization code flow). The frontend
  // navigates here; we bounce to Google's consent screen with a random state
  // that the callback checks against this cookie.
  app.get("/api/v1/auth/google/start", async (_request, reply) => {
    if (!isGoogleRedirectConfigured()) {
      return redirectToFrontendError(reply, "GOOGLE_NOT_CONFIGURED");
    }

    const state = randomBytes(32).toString("base64url");
    // Lax, not strict: the callback arrives as a top-level navigation from
    // accounts.google.com, which wouldn't carry a strict cookie.
    reply.setCookie(GOOGLE_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: GOOGLE_CALLBACK_PATH,
      maxAge: GOOGLE_STATE_TTL_SECONDS,
    });

    return reply.redirect(buildGoogleAuthUrl(state));
  });

  // Google sends the browser back here. On success the user leaves with a
  // refresh cookie only; the frontend's /auth/google page trades it for an
  // access token via /auth/refresh.
  app.get(GOOGLE_CALLBACK_PATH, async (request, reply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    const expectedState = request.cookies[GOOGLE_STATE_COOKIE_NAME];
    reply.clearCookie(GOOGLE_STATE_COOKIE_NAME, { path: GOOGLE_CALLBACK_PATH });

    // The user closed or declined the consent screen.
    if (error) return redirectToFrontendError(reply, "GOOGLE_CANCELLED");

    if (!code || !state || !expectedState || !safeEqual(state, expectedState)) {
      return redirectToFrontendError(reply, "INVALID_GOOGLE_STATE");
    }

    let profile;
    try {
      profile = await exchangeGoogleCode(code);
    } catch (err) {
      request.log.warn({ err }, "Google code exchange failed");
      return redirectToFrontendError(reply, "INVALID_GOOGLE_TOKEN");
    }

    if (!profile.emailVerified) {
      return redirectToFrontendError(reply, "EMAIL_NOT_VERIFIED");
    }

    let user: User;
    try {
      user = await findOrCreateGoogleUser(profile);
    } catch (err) {
      if (err instanceof RegistrationClosedError) return redirectToFrontendError(reply, "REGISTRATION_CLOSED");
      throw err;
    }
    if (isSuspended(user)) {
      return redirectToFrontendError(reply, "ACCOUNT_SUSPENDED");
    }

    setRefreshCookie(reply, await createSession(user.id));
    await markSignedIn(user.id);

    return reply.redirect(`${env.FRONTEND_URL}/auth/google`);
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    if (!isAllowedCookieOrigin(request)) {
      return sendError(reply, 403, "FORBIDDEN_ORIGIN", "This origin may not use the session");
    }

    const token = request.cookies[REFRESH_COOKIE_NAME];
    if (!token) {
      return sendError(reply, 401, "UNAUTHORIZED", "Missing refresh token");
    }

    const session = await rotateSession(token);
    if (!session.ok) {
      clearRefreshCookie(reply);
      return sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired refresh token");
    }

    // Rotation restarts the 30-day clock. A null token means a concurrent
    // refresh already rotated it and the browser holds the newer cookie.
    if (session.token) setRefreshCookie(reply, session.token);

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    // Suspending revokes every session, so this only catches a refresh that
    // raced the suspension — end it the same way.
    if (isSuspended(user)) {
      await revokeAllSessions(user.id);
      clearRefreshCookie(reply);
      return sendError(reply, 403, "ACCOUNT_SUSPENDED", ACCOUNT_SUSPENDED_MESSAGE);
    }

    await markActive(user.id);
    const accessToken = signAccessToken(user.id);
    return reply.send({ data: { accessToken }, error: null });
  });

  // Always answers the same way whether or not the email has an account, so
  // it can't be used to probe which emails are registered.
  app.post("/api/v1/auth/forgot-password", async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const { email } = parsed.data;
    const slot = await takeResendSlot([`reset:${email.toLowerCase()}`, `reset-ip:${request.ip}`]);
    if (!slot.ok) {
      reply.header("Retry-After", String(slot.retryAfterSeconds));
      return reply.code(429).send({
        data: null,
        error: {
          code: "RATE_LIMITED",
          message: `Please wait ${slot.retryAfterSeconds} seconds before requesting another email.`,
          retryAfterSeconds: slot.retryAfterSeconds,
        },
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !isSuspended(user)) {
      const result = await sendPasswordResetEmail(user);
      if (result.status === "failed") {
        request.log.error({ userId: user.id, error: result.error }, "Failed to send password reset email");
      }
    }

    return reply.send({ data: { sent: true }, error: null });
  });

  app.post("/api/v1/auth/reset-password", async (request, reply) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const ok = await resetPasswordWithToken(parsed.data.token, parsed.data.password);
    if (!ok) {
      return sendError(reply, 400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired. Request a new one.");
    }

    // Every session was signed out; the user signs in with the new password.
    clearRefreshCookie(reply);
    return reply.send({ data: { success: true }, error: null });
  });

  app.get("/api/v1/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    return reply.send({ data: toApiUser(user), error: null });
  });

  app.patch("/api/v1/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const {
      fullName,
      email,
      firstName,
      lastName,
      phone,
      occupationTitle,
      professions,
      completeOnboarding,
      profileAutoSync,
      signupIntent,
      careerStage,
      acquisitionSource,
      acquisitionDetail,
      signupSurface,
      signupAttribution,
    } = parsed.data;

    const current = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!current) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    // The email only changes through POST /auth/me/email, which proves the
    // new address with a code. The same email sent back is fine (older
    // clients send the whole form).
    if (email !== undefined && email.toLowerCase() !== current.email.toLowerCase()) {
      return sendError(
        reply,
        400,
        "EMAIL_CHANGE_NEEDS_VERIFICATION",
        "Change your email from Account settings. We'll send a code to the new address."
      );
    }

    const data: Prisma.UserUpdateInput = {};
    if (firstName !== undefined) data.firstName = formatPersonName(firstName);
    if (lastName !== undefined) data.lastName = formatPersonName(lastName);
    if (phone !== undefined) data.phone = phone || null;
    if (profileAutoSync !== undefined) data.profileAutoSync = profileAutoSync;

    // fullName stays in sync with first/last name whenever either changes; an
    // explicit fullName (older clients) still works on its own.
    if (firstName !== undefined || lastName !== undefined) {
      data.fullName =
        [firstName ?? current.firstName, lastName ?? current.lastName]
          .filter((part): part is string => Boolean(part))
          .map(formatPersonName)
          .join(" ") || null;
    } else if (fullName !== undefined) {
      data.fullName = formatPersonName(fullName);
    }

    // Professions: the whole list, or just a new main one (older clients send
    // occupationTitle alone; the rest of the list is kept). Titles matching the
    // catalog take its wording; occupationTitle / occupationId mirror the first.
    const professionList =
      professions !== undefined
        ? professions
        : occupationTitle !== undefined
          ? withMainProfession(occupationTitle, current.professions)
          : undefined;
    if (professionList !== undefined) {
      const resolved = await resolveProfessions(professionList);
      data.professions = resolved.titles;
      data.occupationTitle = resolved.titles[0] ?? null;
      data.occupation = resolved.mainOccupationId ? { connect: { id: resolved.mainOccupationId } } : { disconnect: true };
    }

    if (signupIntent !== undefined) data.signupIntent = signupIntent;
    if (careerStage !== undefined) data.careerStage = careerStage;
    if (acquisitionSource !== undefined) data.acquisitionSource = acquisitionSource;
    if (acquisitionDetail !== undefined) data.acquisitionDetail = acquisitionDetail || null;
    // Where they signed up and how they first arrived are first-touch facts: set once.
    if (signupSurface !== undefined && !current.signupSurface) data.signupSurface = signupSurface;
    if (signupAttribution !== undefined && !current.signupAttribution && Object.keys(signupAttribution).length > 0) {
      data.signupAttribution = signupAttribution as Prisma.InputJsonValue;
    }

    const completingOnboarding = Boolean(completeOnboarding && !current.onboardingCompletedAt);
    if (completingOnboarding) {
      data.onboardingCompletedAt = new Date();
    }

    const user = await prisma.user.update({ where: { id: request.userId }, data });

    if (completingOnboarding) {
      // "Skipped" = finished without giving the essentials (name and profession).
      const skipped = !(user.firstName && user.lastName && user.occupationTitle);
      trackEvent(
        "onboarding_completed",
        user.id,
        {
          skipped,
          intent: user.signupIntent,
          careerStage: user.careerStage,
          source: user.acquisitionSource,
          surface: user.signupSurface,
        },
        `onboarding_completed:${user.id}`
      );
    }

    return reply.send({ data: toApiUser(user), error: null });
  });

  // A first CV made by someone who hasn't finished onboarding (signed up on a
  // /try page, or uploaded their CV during onboarding): fill the account's
  // empty details from it. Only empty fields change.
  app.post("/api/v1/auth/me/onboarding/from-cv", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = onboardingFromCvSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    const { signupAttribution, ...input } = parsed.data;
    try {
      let user = await fillAccountFromCv(request.userId, input);
      if (signupAttribution && !user.signupAttribution && Object.keys(signupAttribution).length > 0) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { signupAttribution: signupAttribution as Prisma.InputJsonValue },
        });
      }
      return reply.send({ data: toApiUser(user), error: null });
    } catch (err) {
      if (err instanceof OnboardingCvNotFoundError) {
        return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", err.message);
      }
      throw err;
    }
  });

  // Starts changing the account's email: re-checks the password (when the
  // account has one) and emails a 6-digit code to the new address. Nothing
  // changes until POST /auth/me/email/confirm gets that code.
  app.post("/api/v1/auth/me/email", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = changeEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    const { newEmail, password } = parsed.data;
    if (user.passwordHash && (!password || !(await comparePassword(password, user.passwordHash)))) {
      return sendError(reply, 400, "WRONG_PASSWORD", "Your password is incorrect");
    }

    return sendEmailChangeCode(user, newEmail, reply);
  });

  // A new code for the pending change (the old one stops working).
  app.post("/api/v1/auth/me/email/resend", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }
    const pending = await pendingEmailChange(user.id);
    if (!pending) {
      return sendError(reply, 400, "NO_PENDING_CHANGE", "There's no email change waiting. Start again.");
    }
    return sendEmailChangeCode(user, pending, reply);
  });

  // The code from the new address: the account moves to it.
  app.post("/api/v1/auth/me/email/confirm", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = confirmEmailChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const slot = await codeAttemptLimiter.take([`ip:${request.ip}`, `user:${request.userId}`]);
    if (!slot.ok) {
      reply.header("Retry-After", String(slot.retryAfterSeconds));
      return sendError(reply, 429, "RATE_LIMITED", `Too many tries. Please wait ${slot.retryAfterSeconds} seconds.`);
    }

    const result = await confirmEmailChange(request.userId, parsed.data.code);
    if (!result.ok) {
      switch (result.reason) {
        case "invalid":
          return sendError(
            reply,
            400,
            "INVALID_CODE",
            `That code isn't right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`
          );
        case "expired":
          return sendError(reply, 400, "CODE_EXPIRED", "This code has expired. Send a new one.");
        case "too_many_attempts":
          return sendError(reply, 400, "TOO_MANY_ATTEMPTS", "Too many wrong tries. Send a new code.");
        case "no_request":
          return sendError(reply, 400, "NO_PENDING_CHANGE", "There's no email change waiting. Start again.");
        case "taken":
          return sendError(reply, 409, "EMAIL_TAKEN", "An account with this email already exists");
      }
    }

    // Billing emails follow the new address. Best effort, after the change:
    // a Polar hiccup never undoes it, and it's logged to fix by hand.
    const polar = await syncPolarCustomerEmail(result.user, result.user.email);
    if (polar.result === "failed") {
      request.log.warn({ userId: result.user.id, err: polar.error }, "Couldn't update the Polar customer's email");
    }

    return reply.send({ data: toApiUser(result.user), error: null });
  });

  // Drops a pending change (the user changed their mind).
  app.delete("/api/v1/auth/me/email", { preHandler: requireAuth }, async (request, reply) => {
    await cancelEmailChange(request.userId);
    return reply.send({ data: { success: true }, error: null });
  });

  // Changes the password, or sets a first one on a Google-only account. Every
  // other session is signed out; this device gets a fresh one.
  app.post("/api/v1/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    const { currentPassword, newPassword } = parsed.data;
    if (user.passwordHash) {
      if (!currentPassword || !(await comparePassword(currentPassword, user.passwordHash))) {
        return sendError(reply, 400, "WRONG_PASSWORD", "Your current password is incorrect");
      }
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    await revokeAllSessions(user.id);
    setRefreshCookie(reply, await createSession(user.id));

    return reply.send({ data: toApiUser(updated), error: null });
  });

  // Permanently deletes the account and everything it owns. Refresh tokens go
  // with the user row (onDelete: Cascade); the rest have no cascade, so they
  // are removed explicitly in the same transaction.
  app.delete("/api/v1/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteAccountSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "User no longer exists");
    }

    const { password, confirmEmail, reason, comment } = parsed.data;
    if (user.passwordHash) {
      if (!password || !(await comparePassword(password, user.passwordHash))) {
        return sendError(reply, 400, "WRONG_PASSWORD", "Your password is incorrect");
      }
    } else if (!confirmEmail || confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
      return sendError(reply, 400, "CONFIRMATION_MISMATCH", "Type your account email to confirm");
    }

    if (hasRenewingPolarSubscription(user)) {
      return sendError(
        reply,
        409,
        "ACTIVE_SUBSCRIPTION",
        "Cancel your Pro subscription first so you aren't billed again, then delete your account"
      );
    }

    // Recorded before the account goes, without anything that identifies them.
    if (reason || comment) await recordDeletionFeedback(user, { reason, comment });

    await deleteUserAccount(user.id);

    clearRefreshCookie(reply);
    return reply.send({ data: { success: true }, error: null });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!isAllowedCookieOrigin(request)) {
      return sendError(reply, 403, "FORBIDDEN_ORIGIN", "This origin may not use the session");
    }
    const token = request.cookies[REFRESH_COOKIE_NAME];
    if (token) await revokeSession(token);
    clearRefreshCookie(reply);
    return reply.send({ data: { success: true }, error: null });
  });

  // Ends every session for this user on every device (e.g. after a password
  // change or a suspected leak). Access tokens already issued stay valid until
  // their 15-minute expiry.
  app.post("/api/v1/auth/logout-all", { preHandler: requireAuth }, async (request, reply) => {
    await revokeAllSessions(request.userId);
    clearRefreshCookie(reply);
    return reply.send({ data: { success: true }, error: null });
  });
}
