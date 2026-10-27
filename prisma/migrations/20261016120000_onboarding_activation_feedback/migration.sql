-- Onboarding answers and first-touch attribution on the user.
ALTER TABLE "User" ADD COLUMN     "acquisitionDetail" TEXT,
ADD COLUMN     "acquisitionSource" TEXT,
ADD COLUMN     "careerStage" TEXT,
ADD COLUMN     "signupAttribution" JSONB,
ADD COLUMN     "signupIntent" TEXT,
ADD COLUMN     "signupSurface" TEXT;

-- Product analytics events (the activation funnel).
CREATE TABLE "ProductEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "name" TEXT NOT NULL,
    "props" JSONB,
    "source" TEXT NOT NULL DEFAULT 'server',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- Ratings, thumbs on AI drafts, and account-deletion reasons.
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "rating" INTEGER,
    "reason" TEXT,
    "comment" TEXT,
    "cvDocumentId" TEXT,
    "flowType" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- One-time UI prompts (checklist, tour offer, CV rating).
CREATE TABLE "UserPrompt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "shownAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPrompt_pkey" PRIMARY KEY ("id")
);

-- Lifecycle emails, one row per user per kind.
CREATE TABLE "LifecycleEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "LifecycleEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductEvent_dedupeKey_key" ON "ProductEvent"("dedupeKey");
CREATE INDEX "ProductEvent_name_createdAt_idx" ON "ProductEvent"("name", "createdAt");
CREATE INDEX "ProductEvent_userId_name_idx" ON "ProductEvent"("userId", "name");
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt");
CREATE INDEX "Feedback_kind_createdAt_idx" ON "Feedback"("kind", "createdAt");
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");
CREATE UNIQUE INDEX "UserPrompt_userId_key_key" ON "UserPrompt"("userId", "key");
CREATE INDEX "LifecycleEmail_kind_createdAt_idx" ON "LifecycleEmail"("kind", "createdAt");
CREATE UNIQUE INDEX "LifecycleEmail_userId_kind_key" ON "LifecycleEmail"("userId", "kind");

ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserPrompt" ADD CONSTRAINT "UserPrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LifecycleEmail" ADD CONSTRAINT "LifecycleEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Accounts that existed before lifecycle emails: they never get a welcome,
-- nudge or reminder out of the blue. Marked as skipped, so the scheduler
-- only ever emails accounts created from now on.
INSERT INTO "LifecycleEmail" ("id", "userId", "kind", "status")
SELECT gen_random_uuid()::text, u."id", k.kind, 'skipped'
FROM "User" u
CROSS JOIN (VALUES ('welcome'), ('first_cv_nudge'), ('download_reminder')) AS k(kind);

-- Existing accounts already have CVs and know the dashboard: don't show them
-- the getting-started checklist or the tour offer.
INSERT INTO "UserPrompt" ("id", "userId", "key", "dismissedAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", k.key, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN (VALUES ('checklist'), ('tour_offer')) AS k(key);
