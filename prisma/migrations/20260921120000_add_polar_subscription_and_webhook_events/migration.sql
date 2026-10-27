-- AlterTable
ALTER TABLE "User" ADD COLUMN     "polarCustomerId" TEXT,
ADD COLUMN     "polarProductId" TEXT,
ADD COLUMN     "polarSubscriptionId" TEXT,
ADD COLUMN     "subscriptionCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionCurrentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "subscriptionStatus" TEXT;

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_polarCustomerId_key" ON "User"("polarCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_polarSubscriptionId_key" ON "User"("polarSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");
