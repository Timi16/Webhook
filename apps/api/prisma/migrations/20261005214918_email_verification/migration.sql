-- AlterTable
ALTER TABLE "Developer" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verifyCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verifyCodeHash" TEXT,
ADD COLUMN     "verifyCodeSentAt" TIMESTAMP(3);

-- Accounts that existed before verification was introduced are treated as verified.
UPDATE "Developer" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;
