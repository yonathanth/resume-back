-- Several professions per user (main one first); occupationTitle keeps mirroring the first.
ALTER TABLE "User" ADD COLUMN "professions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Everyone who already has a profession starts with it as their only one.
UPDATE "User" SET "professions" = ARRAY["occupationTitle"] WHERE "occupationTitle" IS NOT NULL;
