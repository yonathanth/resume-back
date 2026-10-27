-- Career Profiles rebuild: a profile is now one per user per role and holds
-- its own structured content (see CareerProfile in schema.prisma). The old
-- profiles were title-only containers whose data can't be mapped onto the
-- new shape, so they're dropped (CVs are detached, never deleted).
UPDATE "CVDocument" SET "profileId" = NULL WHERE "profileId" IS NOT NULL;
UPDATE "CVImport" SET "profileId" = NULL WHERE "profileId" IS NOT NULL;
DELETE FROM "CareerProfile";

-- DropForeignKey
ALTER TABLE "CVImport" DROP CONSTRAINT "CVImport_profileId_fkey";

-- DropForeignKey
ALTER TABLE "CareerProfile" DROP CONSTRAINT "CareerProfile_userId_fkey";

-- AlterTable
ALTER TABLE "CVDocument" ADD COLUMN     "profileVersion" INTEGER;

-- AlterTable
ALTER TABLE "CVImport" DROP COLUMN "profileId";

-- AlterTable
ALTER TABLE "CareerProfile" DROP COLUMN "isPrimary",
DROP COLUMN "summaryCvCount",
DROP COLUMN "summaryDomain",
DROP COLUMN "summaryHighlight",
DROP COLUMN "summaryReadinessScore",
DROP COLUMN "summarySkills",
DROP COLUMN "summaryTargetCompanies",
ADD COLUMN     "content" JSONB NOT NULL,
ADD COLUMN     "occupationId" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "roleKey" TEXT NOT NULL,
ADD COLUMN     "seniority" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ProfileChange" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cvDocumentId" TEXT,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "previousContent" JSONB NOT NULL,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileChange_profileId_createdAt_idx" ON "ProfileChange"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "CVDocument_userId_idx" ON "CVDocument"("userId");

-- CreateIndex
CREATE INDEX "CVDocument_profileId_idx" ON "CVDocument"("profileId");

-- CreateIndex
CREATE INDEX "CareerProfile_userId_idx" ON "CareerProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerProfile_userId_roleKey_key" ON "CareerProfile"("userId", "roleKey");

-- AddForeignKey
ALTER TABLE "CareerProfile" ADD CONSTRAINT "CareerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerProfile" ADD CONSTRAINT "CareerProfile_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChange" ADD CONSTRAINT "ProfileChange_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CareerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

