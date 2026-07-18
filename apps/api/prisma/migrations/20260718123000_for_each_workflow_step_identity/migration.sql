DROP INDEX IF EXISTS "step_executions_execution_id_workflow_step_id_key";

CREATE UNIQUE INDEX "step_executions_execution_id_workflow_step_id_execution_path_key"
  ON "step_executions"("execution_id", "workflow_step_id", "execution_path")
  WHERE "workflow_step_id" IS NOT NULL;
