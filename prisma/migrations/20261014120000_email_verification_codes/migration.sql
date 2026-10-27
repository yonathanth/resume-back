-- Email verification by 6-digit code: count wrong tries per code so a code
-- can't be guessed (at most 5 tries, then a new code is needed).
ALTER TABLE "EmailVerificationToken" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
