ALTER TABLE "triggers"
  ALTER COLUMN "token_hash" DROP NOT NULL,
  ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cron" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "execution_policy" TEXT NOT NULL DEFAULT 'skip_if_running',
  ADD COLUMN "last_run_at" TIMESTAMP(3),
  ADD COLUMN "next_run_at" TIMESTAMP(3);

ALTER TABLE "executions"
  ADD COLUMN "scheduled_trigger_id" TEXT,
  ADD COLUMN "scheduled_for" TIMESTAMP(3);

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_scheduled_trigger_id_fkey"
  FOREIGN KEY ("scheduled_trigger_id") REFERENCES "triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "triggers_type_enabled_paused_deleted_at_next_run_at_idx"
  ON "triggers"("type", "enabled", "paused", "deleted_at", "next_run_at");

CREATE INDEX "executions_organization_id_scheduled_trigger_id_scheduled_for_idx"
  ON "executions"("organization_id", "scheduled_trigger_id", "scheduled_for");

CREATE UNIQUE INDEX "executions_scheduled_trigger_once_idx"
  ON "executions"("organization_id", "scheduled_trigger_id", "scheduled_for")
  WHERE "scheduled_trigger_id" IS NOT NULL AND "scheduled_for" IS NOT NULL;
