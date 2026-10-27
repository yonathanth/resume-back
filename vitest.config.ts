import { defineConfig } from "vitest/config";

// Tests never touch the real database or real providers. Every variable the
// app reads is set here, so nothing falls through to the developer's .env
// (dotenv never overrides a variable that's already set).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:55432/fitcv_test";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Integration tests share one database — run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: "test-access-secret-not-for-production",
      FRONTEND_URL: "http://localhost:3002",
      CORS_ORIGIN: "http://localhost:3002",
      EMAIL_PROVIDER: "console",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
      VAPID_SUBJECT: "",
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "test-groq-key",
      GEMINI_API_KEY: "",
      MISTRAL_API_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      CHAPA_SECRET_KEY: "test-chapa",
      CHAPA_RETURN_URL: "http://localhost:3002/payment/chapa/return",
      CHAPA_WEBHOOK_SECRET: "test-chapa-webhook",
      POLAR_ACCESS_TOKEN: "test-polar-token",
      POLAR_WEBHOOK_SECRET: "test-polar-webhook",
      POLAR_PRODUCT_ID: "test-product",
      POLAR_PRODUCT_PLUS_MONTHLY_ID: "test-plus-monthly",
      POLAR_PRODUCT_PRO_MONTHLY_ID: "test-pro-monthly",
      POLAR_PRODUCT_PRO_WEEKLY_ID: "test-pro-weekly",
      POLAR_PRODUCT_MONTHLY_ID: "test-legacy-monthly",
      POLAR_PRODUCT_PLUS_LIFETIME_ID: "test-plus-lifetime",
      POLAR_PRODUCT_CV_NEW_ID: "test-cv-new",
      POLAR_PRODUCT_CV_EDIT_ID: "test-cv-edit",
      POLAR_SERVER: "sandbox",
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: "",
    },
  },
});
