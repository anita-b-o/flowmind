-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IdempotencyStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "IdempotencyStatus" ADD VALUE 'ENQUEUED';

-- AlterTable
ALTER TABLE "internal_records" ADD COLUMN     "workflow_version_id" TEXT;

-- AlterTable
ALTER TABLE "triggers" ADD COLUMN     "rotated_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "internal_records" ADD CONSTRAINT "internal_records_workflow_version_id_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
