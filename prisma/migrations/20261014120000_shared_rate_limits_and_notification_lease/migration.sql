-- Shared rate limits and resumable announcement delivery.
-- Additive only: one new table and one new nullable column. No existing
-- column, row or constraint is dropped or rewritten, apart from filling the
-- missing subscription provider at the end.

-- CreateTable
CREATE TABLE "RateLimitHit" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitHit_key_createdAt_idx" ON "RateLimitHit"("key", "createdAt");

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "leaseUntil" TIMESTAMP(3);

-- Polar subscription sync never recorded the provider. Fill it in for users
-- whose billing came from Polar and who have no provider yet (Chapa users
-- already have "CHAPA" and are untouched).
UPDATE "User" SET "subscriptionProvider" = 'POLAR'
WHERE "subscriptionProvider" IS NULL AND "polarSubscriptionId" IS NOT NULL;
