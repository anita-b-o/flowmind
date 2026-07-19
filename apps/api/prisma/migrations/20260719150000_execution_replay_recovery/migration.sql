CREATE TYPE "ExecutionReplayMode" AS ENUM ('FULL_REPLAY', 'RETRY_FROM_FAILURE');

ALTER TABLE "executions"
  ADD COLUMN "replay_of_execution_id" TEXT,
  ADD COLUMN "replay_mode" "ExecutionReplayMode",
  ADD COLUMN "replay_from_step_key" TEXT,
  ADD COLUMN "replay_from_execution_path" TEXT,
  ADD COLUMN "replay_from_iteration_index" INTEGER;

UPDATE "executions"
SET "replay_of_execution_id" = "retry_of_execution_id",
    "replay_mode" = 'FULL_REPLAY'
WHERE "retry_of_execution_id" IS NOT NULL;

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_replay_of_execution_id_fkey"
  FOREIGN KEY ("replay_of_execution_id") REFERENCES "executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "executions_organization_id_replay_of_execution_id_created_at_idx"
  ON "executions"("organization_id", "replay_of_execution_id", "created_at");

CREATE TABLE "execution_step_reuses" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "recovery_execution_id" TEXT NOT NULL,
  "source_execution_id" TEXT NOT NULL,
  "source_step_execution_id" TEXT NOT NULL,
  "step_key" TEXT NOT NULL,
  "step_type" TEXT NOT NULL,
  "execution_path" TEXT NOT NULL DEFAULT 'root',
  "iteration_index" INTEGER,
  "status" "StepExecutionStatus" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_step_reuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_step_reuses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "execution_step_reuses_recovery_execution_id_fkey" FOREIGN KEY ("recovery_execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "execution_step_reuses_source_execution_id_fkey" FOREIGN KEY ("source_execution_id") REFERENCES "executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "execution_step_reuses_source_step_execution_id_fkey" FOREIGN KEY ("source_step_execution_id") REFERENCES "step_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "execution_step_reuses_recovery_execution_id_step_key_execution_path_key"
  ON "execution_step_reuses"("recovery_execution_id", "step_key", "execution_path");
CREATE INDEX "execution_step_reuses_organization_id_recovery_execution_id_idx"
  ON "execution_step_reuses"("organization_id", "recovery_execution_id");
CREATE INDEX "execution_step_reuses_source_execution_id_idx"
  ON "execution_step_reuses"("source_execution_id");
