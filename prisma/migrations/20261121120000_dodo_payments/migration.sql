-- Dodo Payments replaces Polar as the card / subscription provider.
-- Additive only: three nullable columns and their unique indexes. The Polar
-- columns and their data are left as they are.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dodoCustomerId" TEXT,
ADD COLUMN     "dodoProductId" TEXT,
ADD COLUMN     "dodoSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_dodoCustomerId_key" ON "User"("dodoCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_dodoSubscriptionId_key" ON "User"("dodoSubscriptionId");
