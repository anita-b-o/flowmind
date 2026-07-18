ALTER TABLE "step_executions"
  ADD COLUMN "execution_path" TEXT NOT NULL DEFAULT 'root',
  ADD COLUMN "iteration_index" INTEGER,
  ADD COLUMN "error_handled" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "step_executions_execution_id_step_key_key";

CREATE UNIQUE INDEX "step_executions_execution_id_step_key_execution_path_key"
  ON "step_executions"("execution_id", "step_key", "execution_path");
