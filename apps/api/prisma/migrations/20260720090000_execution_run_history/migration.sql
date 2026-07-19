CREATE TABLE "step_execution_attempts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "step_execution_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "StepExecutionStatus" NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "next_retry_at" TIMESTAMP(3),
    "wait_reason" TEXT,
    "effect_status" TEXT,
    "error_category" TEXT,
    "error_code_safe" TEXT,
    "error_message_safe" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "step_execution_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "step_execution_attempts_step_execution_id_attempt_key"
ON "step_execution_attempts"("step_execution_id", "attempt");

CREATE INDEX "step_execution_attempts_organization_id_execution_id_started_at_id_idx"
ON "step_execution_attempts"("organization_id", "execution_id", "started_at", "id");

CREATE INDEX "executions_organization_id_execution_mode_created_at_id_idx"
ON "executions"("organization_id", "execution_mode", "created_at" DESC, "id" DESC);

CREATE INDEX "executions_organization_id_execution_mode_status_created_at_id_idx"
ON "executions"("organization_id", "execution_mode", "status", "created_at" DESC, "id" DESC);

CREATE INDEX "executions_organization_id_root_execution_id_created_at_id_idx"
ON "executions"("organization_id", "root_execution_id", "created_at", "id");

CREATE INDEX "step_executions_organization_id_status_execution_id_idx"
ON "step_executions"("organization_id", "status", "execution_id");

ALTER TABLE "step_execution_attempts" ADD CONSTRAINT "step_execution_attempts_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "step_execution_attempts" ADD CONSTRAINT "step_execution_attempts_execution_id_fkey"
FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "step_execution_attempts" ADD CONSTRAINT "step_execution_attempts_step_execution_id_fkey"
FOREIGN KEY ("step_execution_id") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
