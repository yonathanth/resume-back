-- Free-tier usage per dashboard tab instead of one shared pool (schema change
-- from 2026-10-08 that was applied with db push and never got a migration, so
-- a database built from migrations alone was missing these columns).
-- Guarded, so it's a no-op on a database that already has them.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "freeCreateUsed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "freeTailorUsed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "freeImproveUsed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" DROP COLUMN IF EXISTS "freeGenerationsUsed";
