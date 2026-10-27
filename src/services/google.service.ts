import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";

const client = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

// Server-side authorization code flow — needs the client secret on top of the ID.
const redirectClient =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? new OAuth2Client({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_CALLBACK_URL,
      })
    : null;

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  fullName: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  if (!client || !env.GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_NOT_CONFIGURED");
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("INVALID_GOOGLE_TOKEN");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified ?? false,
    fullName: payload.name ?? null,
  };
}

export function isGoogleRedirectConfigured(): boolean {
  return redirectClient !== null;
}

// The Google consent-screen URL. `state` is echoed back to the callback and
// checked against a cookie there (CSRF protection).
export function buildGoogleAuthUrl(state: string): string {
  if (!redirectClient) throw new Error("GOOGLE_NOT_CONFIGURED");
  return redirectClient.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

// Trades the callback's one-time code for tokens and verifies the ID token
// that comes back with them.
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  if (!redirectClient) throw new Error("GOOGLE_NOT_CONFIGURED");
  const { tokens } = await redirectClient.getToken(code);
  if (!tokens.id_token) throw new Error("INVALID_GOOGLE_TOKEN");
  return verifyGoogleIdToken(tokens.id_token);
}
