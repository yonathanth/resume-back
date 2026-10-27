-- DropForeignKey
ALTER TABLE "CVDocument" DROP CONSTRAINT "CVDocument_profileId_fkey";

-- DropForeignKey
ALTER TABLE "CVImport" DROP CONSTRAINT "CVImport_profileId_fkey";

-- AlterTable
ALTER TABLE "CVDocument" ADD COLUMN     "title" TEXT;

-- AddForeignKey
ALTER TABLE "CVDocument" ADD CONSTRAINT "CVDocument_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CareerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CVImport" ADD CONSTRAINT "CVImport_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CareerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
