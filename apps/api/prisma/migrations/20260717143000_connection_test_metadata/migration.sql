ALTER TABLE "connections"
  ADD COLUMN "last_tested_at" TIMESTAMP(3),
  ADD COLUMN "last_test_status" TEXT,
  ADD COLUMN "last_test_status_code" INTEGER,
  ADD COLUMN "last_test_duration_ms" INTEGER,
  ADD COLUMN "last_test_message" TEXT;

CREATE INDEX "connections_organization_id_status_updated_at_idx" ON "connections"("organization_id", "status", "updated_at");
