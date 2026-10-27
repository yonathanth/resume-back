-- AlterTable
ALTER TABLE "CareerProfile" ADD COLUMN     "summaryCvCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "summaryDomain" TEXT,
ADD COLUMN     "summaryHighlight" TEXT,
ADD COLUMN     "summaryReadinessScore" INTEGER,
ADD COLUMN     "summarySkills" JSONB,
ADD COLUMN     "summaryTargetCompanies" JSONB;
