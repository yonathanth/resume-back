import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  CORS_ORIGIN: z.string().default("http://localhost:3000,http://localhost:3002"),
  // SameSite of the refresh-token cookie. Unset: "none" in production, so the
  // session survives when the frontend and API are on different sites (e.g.
  // app.vercel.app + api.onrender.com), "lax" otherwise. Set "lax" when both
  // share a site (app.example.com + api.example.com). The refresh and logout
  // endpoints only accept requests from CORS_ORIGIN either way.
  REFRESH_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).optional(),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  PORT: z.coerce.number().positive().default(8000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Redirect (authorization code) sign-in — see auth.routes.ts's
  // /auth/google/start + /auth/google/callback. The callback URL must be listed
  // under "Authorized redirect URIs" on the Google OAuth client.
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().default("http://localhost:8000/api/v1/auth/google/callback"),
  // Where the backend sends the browser back to after redirect-based sign-in,
  // and the base of the links in confirmation emails.
  FRONTEND_URL: z.string().default("http://localhost:3002"),
  // Confirmation emails (services/emailVerification.service.ts). EMAIL_FROM
  // must be on a domain verified in Resend, e.g. "GoMoxie <no-reply@example.com>".
  // When either is missing outside production, links are logged instead.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Which email provider sends mail (services/email): "resend", or "console"
  // to only log messages. Unset picks resend when RESEND_API_KEY and
  // EMAIL_FROM are set, else console outside production.
  EMAIL_PROVIDER: z.enum(["resend", "console"]).optional(),
  // Browser push (services/push.service.ts). Generate a pair with
  // `npx web-push generate-vapid-keys`. Push stays off until all three are set.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // A mailto: or https: contact for push services, e.g. "mailto:ops@example.com".
  VAPID_SUBJECT: z.string().optional(),
  // Which AI service writes CVs: "groq", "gemini" or "mistral" (see services/ai/index.ts).
  // Only the selected provider's key is required.
  AI_PROVIDER: z.enum(["groq", "gemini", "mistral"]).default("groq"),
  // Cap on a CV generation's reply, reasoning tokens included.
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  // How long gpt-oss models "think" before answering (billed as output
  // tokens). Ignored for models without reasoning support.
  GROQ_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  // Gemini "thinking" (billed as output tokens); "none" turns it off on Flash models.
  GEMINI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("low"),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().default("mistral-medium-latest"),
  CHAPA_SECRET_KEY: z.string().min(1, "CHAPA_SECRET_KEY is required"),
  CHAPA_PUBLIC_KEY: z.string().optional(),
  CHAPA_BASE_URL: z.string().default("https://api.chapa.global"),
  // v2 (api.chapa.global) currently rejects this account's key with 401 —
  // default to the confirmed-working v1 API until Chapa resolves v2 access.
  // Flip to "v2" (no code change needed) once that's sorted out.
  CHAPA_API_VERSION: z.enum(["v1", "v2"]).default("v1"),
  CHAPA_RETURN_URL: z.string().min(1, "CHAPA_RETURN_URL is required"),
  CHAPA_WEBHOOK_URL: z.string().optional(),
  CHAPA_WEBHOOK_SECRET: z.string().min(1, "CHAPA_WEBHOOK_SECRET is required"),
  // Chapa can't auto-renew, so this buys a fixed 1-month Pro period (see
  // entitlement.service.ts / payment.service.ts's grantChapaProPeriod) —
  // the local-market alternative to Polar's $5/month.
  CV_PAYMENT_PRICE: z.coerce.number().positive().default(80),
  CV_PAYMENT_CURRENCY: z.string().default("ETB"),
  POLAR_WEBHOOK_SECRET: z.string().min(1, "POLAR_WEBHOOK_SECRET is required"),
  POLAR_ACCESS_TOKEN: z.string().min(1, "POLAR_ACCESS_TOKEN is required"),
  POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
  // Where Polar sends the customer back after checkout — mirrors
  // CHAPA_RETURN_URL's convention. Defaults to the frontend's local dev
  // port; override in production.
  POLAR_CHECKOUT_RETURN_URL: z.string().default("http://localhost:3002/payment/polar/return"),
  // Plus / Pro subscriptions (see services/polar/plans.ts) — each plan and
  // billing period is its own Polar product. Optional so the server can boot
  // before they're all filled in; a checkout for one that's still empty fails
  // clearly at request time (PLAN_NOT_CONFIGURED) instead of at startup.
  POLAR_PRODUCT_PLUS_WEEKLY_ID: z.string().optional(),
  POLAR_PRODUCT_PLUS_MONTHLY_ID: z.string().optional(),
  POLAR_PRODUCT_PLUS_QUARTERLY_ID: z.string().optional(),
  POLAR_PRODUCT_PRO_WEEKLY_ID: z.string().optional(),
  POLAR_PRODUCT_PRO_MONTHLY_ID: z.string().optional(),
  POLAR_PRODUCT_PRO_QUARTERLY_ID: z.string().optional(),
  // The retired single-plan products ($4.99 / $9.99 / $24.99). Their
  // subscribers are on Plus now; kept so they're still recognized.
  POLAR_PRODUCT_WEEKLY_ID: z.string().optional(),
  POLAR_PRODUCT_MONTHLY_ID: z.string().optional(),
  POLAR_PRODUCT_QUARTERLY_ID: z.string().optional(),
  // One-time Polar products: Plus Lifetime, and unlocking one CV's download
  // (a new CV, or a tailored / improved one) — see credit-fulfillment.service.ts.
  POLAR_PRODUCT_PLUS_LIFETIME_ID: z.string().optional(),
  POLAR_PRODUCT_CV_NEW_ID: z.string().optional(),
  POLAR_PRODUCT_CV_EDIT_ID: z.string().optional(),
  // Behind a proxy (Render, and Vercel forwarding /api/v1 to it): trust its
  // X-Forwarded-For, so request.ip — and every per-IP rate limit — is the
  // visitor's, not the proxy's. Leave off when the server faces the internet directly.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Chromium (PDFs, template previews) in a container that runs as root, as on
  // Render: it needs --no-sandbox there. Leave off on a normal machine.
  CHROME_NO_SANDBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // PDF / preview renders at once. Each Chromium page holds a whole render in
  // memory: 1 on a small (512 MB) instance.
  MAX_CONCURRENT_RENDERS: z.coerce.number().int().min(1).max(10).default(3),
}).superRefine((env, ctx) => {
  // Only the AI provider actually in use needs a key.
  const keyName = ({ groq: "GROQ_API_KEY", gemini: "GEMINI_API_KEY", mistral: "MISTRAL_API_KEY" } as const)[env.AI_PROVIDER];
  if (!env[keyName]) {
    ctx.addIssue({ code: "custom", path: [keyName], message: `${keyName} is required when AI_PROVIDER=${env.AI_PROVIDER}` });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// CORS_ORIGIN may be a single origin or a comma-separated list (e.g. when the
// frontend dev server can land on more than one port).
export const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
