ALTER TABLE "executions"
ADD COLUMN "started_by_user_id" TEXT,
ADD COLUMN "cancel_requested_by_user_id" TEXT,
ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
ADD COLUMN "cancelled_at" TIMESTAMP(3),
ADD COLUMN "cancel_reason" TEXT,
ADD COLUMN "manual_execution_key" TEXT;

ALTER TABLE "executions"
ADD CONSTRAINT "executions_started_by_user_id_fkey"
FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "executions"
ADD CONSTRAINT "executions_cancel_requested_by_user_id_fkey"
FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "executions_organization_id_manual_execution_key_idx"
ON "executions"("organization_id", "manual_execution_key");

CREATE UNIQUE INDEX "executions_manual_execution_key_unique"
ON "executions"("organization_id", "manual_execution_key")
WHERE "manual_execution_key" IS NOT NULL;
