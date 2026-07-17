CREATE TYPE "ExecutionMode" AS ENUM ('REAL', 'TEST');
CREATE TYPE "TestExternalMode" AS ENUM ('mock', 'real');

ALTER TABLE "executions"
  ADD COLUMN "execution_mode" "ExecutionMode" NOT NULL DEFAULT 'REAL';

ALTER TABLE "step_executions"
  ADD COLUMN "debug_json" JSONB;

CREATE TABLE "workflow_test_runs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "workflow_version_id" TEXT NOT NULL,
  "execution_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "external_mode" "TestExternalMode" NOT NULL DEFAULT 'mock',
  "display_name" TEXT,
  "payload_json" JSONB NOT NULL,
  "step_mocks_json" JSONB NOT NULL,
  "draft_definition_json" JSONB,
  "compare_with_last_real" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "workflow_test_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_test_runs_execution_id_key" ON "workflow_test_runs"("execution_id");
CREATE INDEX "workflow_test_runs_organization_id_workflow_id_created_at_idx" ON "workflow_test_runs"("organization_id", "workflow_id", "created_at");
CREATE INDEX "workflow_test_runs_organization_id_execution_id_idx" ON "workflow_test_runs"("organization_id", "execution_id");
CREATE INDEX "executions_organization_id_workflow_id_execution_mode_created_at_idx" ON "executions"("organization_id", "workflow_id", "execution_mode", "created_at");

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_workflow_version_id_fkey"
  FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
