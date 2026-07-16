ALTER TYPE "ExecutionStatus" ADD VALUE IF NOT EXISTS 'RETRYING';

ALTER TABLE "executions"
ADD COLUMN "locked_by" TEXT,
ADD COLUMN "locked_until" TIMESTAMP(3),
ADD COLUMN "last_heartbeat_at" TIMESTAMP(3),
ADD COLUMN "run_attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retry_of_execution_id" TEXT,
ADD COLUMN "retry_requested_by_user_id" TEXT,
ADD COLUMN "retry_requested_at" TIMESTAMP(3),
ADD COLUMN "retry_reason" TEXT;

ALTER TABLE "executions"
ADD CONSTRAINT "executions_retry_of_execution_id_fkey"
FOREIGN KEY ("retry_of_execution_id") REFERENCES "executions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "executions"
ADD CONSTRAINT "executions_retry_requested_by_user_id_fkey"
FOREIGN KEY ("retry_requested_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "executions_status_locked_until_idx" ON "executions"("status", "locked_until");
CREATE INDEX "executions_retry_of_execution_id_status_idx" ON "executions"("retry_of_execution_id", "status");

CREATE TABLE "dead_letter_executions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "execution_id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "workflow_version_id" TEXT NOT NULL,
  "source_queue" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "failed_step_key" TEXT,
  "failed_step_execution_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error_json" JSONB,
  "job_id" TEXT,
  "retry_execution_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "resolution" TEXT,
  CONSTRAINT "dead_letter_executions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_execution_id_fkey"
FOREIGN KEY ("execution_id") REFERENCES "executions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_workflow_id_fkey"
FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_workflow_version_id_fkey"
FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_failed_step_execution_id_fkey"
FOREIGN KEY ("failed_step_execution_id") REFERENCES "step_executions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "dead_letter_executions"
ADD CONSTRAINT "dead_letter_executions_retry_execution_id_fkey"
FOREIGN KEY ("retry_execution_id") REFERENCES "executions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "dead_letter_executions_active_execution_key"
ON "dead_letter_executions"("execution_id")
WHERE "resolved_at" IS NULL;

CREATE INDEX "dead_letter_executions_organization_id_idx" ON "dead_letter_executions"("organization_id");
CREATE INDEX "dead_letter_executions_execution_id_idx" ON "dead_letter_executions"("execution_id");
CREATE INDEX "dead_letter_executions_created_at_idx" ON "dead_letter_executions"("created_at");
CREATE INDEX "dead_letter_executions_resolved_at_idx" ON "dead_letter_executions"("resolved_at");
