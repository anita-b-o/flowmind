ALTER TABLE "workflow_test_runs"
  ADD COLUMN "snapshot_definition_json" JSONB,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'version',
  ADD COLUMN "real_mode_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "real_mode_confirmed_by_user_id" TEXT;

ALTER TABLE "executions"
  DROP CONSTRAINT IF EXISTS "executions_workflow_version_id_fkey";

ALTER TABLE "workflow_test_runs"
  DROP CONSTRAINT IF EXISTS "workflow_test_runs_workflow_version_id_fkey";

ALTER TABLE "executions"
  ALTER COLUMN "workflow_version_id" DROP NOT NULL;

ALTER TABLE "workflow_test_runs"
  ALTER COLUMN "workflow_version_id" DROP NOT NULL;

UPDATE "workflow_test_runs" AS tr
SET
  "snapshot_definition_json" = COALESCE(tr."draft_definition_json", wv."definition_json"),
  "source" = CASE WHEN tr."draft_definition_json" IS NULL THEN 'version' ELSE 'draft' END,
  "real_mode_confirmed_at" = CASE WHEN tr."external_mode" = 'real' THEN tr."created_at" ELSE NULL END,
  "real_mode_confirmed_by_user_id" = CASE WHEN tr."external_mode" = 'real' THEN tr."created_by_user_id" ELSE NULL END
FROM "workflow_versions" AS wv
WHERE tr."workflow_version_id" = wv."id";

ALTER TABLE "workflow_test_runs"
  ALTER COLUMN "snapshot_definition_json" SET NOT NULL;

ALTER TABLE "step_executions"
  DROP CONSTRAINT IF EXISTS "step_executions_workflow_step_id_fkey";

DROP INDEX IF EXISTS "step_executions_execution_id_workflow_step_id_key";

ALTER TABLE "step_executions"
  ALTER COLUMN "workflow_step_id" DROP NOT NULL;

CREATE UNIQUE INDEX "step_executions_execution_id_step_key_key"
  ON "step_executions"("execution_id", "step_key");

CREATE UNIQUE INDEX "step_executions_execution_id_workflow_step_id_key"
  ON "step_executions"("execution_id", "workflow_step_id")
  WHERE "workflow_step_id" IS NOT NULL;

ALTER TABLE "step_executions"
  ADD CONSTRAINT "step_executions_workflow_step_id_fkey"
  FOREIGN KEY ("workflow_step_id") REFERENCES "workflow_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_workflow_version_id_fkey"
  FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workflow_test_runs"
  ADD CONSTRAINT "workflow_test_runs_workflow_version_id_fkey"
  FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workflow_test_runs_organization_id_workflow_version_id_idx"
  ON "workflow_test_runs"("organization_id", "workflow_version_id");
