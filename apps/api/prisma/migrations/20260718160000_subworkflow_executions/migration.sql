ALTER TABLE "executions"
  ADD COLUMN "parent_execution_id" TEXT,
  ADD COLUMN "parent_step_execution_id" TEXT,
  ADD COLUMN "root_execution_id" TEXT,
  ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "output_json" JSONB;

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_parent_execution_id_fkey" FOREIGN KEY ("parent_execution_id") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "executions_parent_step_execution_id_fkey" FOREIGN KEY ("parent_step_execution_id") REFERENCES "step_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "executions_root_execution_id_fkey" FOREIGN KEY ("root_execution_id") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "executions_parent_execution_id_idx" ON "executions"("parent_execution_id");
CREATE INDEX "executions_parent_step_execution_id_idx" ON "executions"("parent_step_execution_id");
CREATE INDEX "executions_root_execution_id_idx" ON "executions"("root_execution_id");
