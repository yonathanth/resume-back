-- Plus / Pro plans, pay-per-CV unlocks.

-- Paid-plan usage for the current billing period.
ALTER TABLE "User" ADD COLUMN "usagePeriodKey" TEXT;
ALTER TABLE "User" ADD COLUMN "periodCreateUses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "periodTailorUses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "periodImproveUses" INTEGER NOT NULL DEFAULT 0;

-- Which flow paid for a CV, and its pay-per-CV lock.
ALTER TABLE "CVDocument" ADD COLUMN "chargedFlow" TEXT;
ALTER TABLE "CVDocument" ADD COLUMN "chargedAt" TIMESTAMP(3);
ALTER TABLE "CVDocument" ADD COLUMN "unlockProduct" TEXT;
ALTER TABLE "CVDocument" ADD COLUMN "lockedTier" TEXT;
ALTER TABLE "CVDocument" ADD COLUMN "unlockedAt" TIMESTAMP(3);

CREATE INDEX "CVDocument_userId_unlockProduct_idx" ON "CVDocument"("userId", "unlockProduct");

-- CVs the AI already wrote were paid for under the old rules: later AI passes
-- on them stay free, and none of them are locked.
UPDATE "CVDocument" SET "chargedAt" = "createdAt" WHERE "source" = 'ai';
