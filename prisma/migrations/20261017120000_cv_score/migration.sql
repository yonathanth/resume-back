-- CV score (rules engine in src/services/score/engine.ts) and the cached,
-- AI-extracted requirements of the CV's job description.
ALTER TABLE "CVDocument" ADD COLUMN "score" INTEGER;
ALTER TABLE "CVDocument" ADD COLUMN "scoreVersion" TEXT;
ALTER TABLE "CVDocument" ADD COLUMN "jobRequirements" JSONB;
