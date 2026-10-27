-- Make CVDocument/CVImport.profileId optional: a CV is a standalone
-- generated document that may or may not belong to a Career Profile.
ALTER TABLE "CVDocument" ALTER COLUMN "profileId" DROP NOT NULL;
ALTER TABLE "CVImport" ALTER COLUMN "profileId" DROP NOT NULL;

-- Retire the "hidden bucket profile" workaround: detach any CVs/imports that
-- were parked under a system-default bucket profile instead of deleting
-- them, then remove the bucket profiles themselves.
UPDATE "CVDocument"
SET "profileId" = NULL
WHERE "profileId" IN (SELECT "id" FROM "CareerProfile" WHERE "isSystemDefault" = true);

UPDATE "CVImport"
SET "profileId" = NULL
WHERE "profileId" IN (SELECT "id" FROM "CareerProfile" WHERE "isSystemDefault" = true);

DELETE FROM "CareerProfile" WHERE "isSystemDefault" = true;

ALTER TABLE "CareerProfile" DROP COLUMN "isSystemDefault";
