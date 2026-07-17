ALTER TABLE "triggers"
  ADD COLUMN "http_method" TEXT NOT NULL DEFAULT 'POST',
  ADD COLUMN "token_preview" TEXT,
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "last_received_at" TIMESTAMP(3),
  ADD COLUMN "last_execution_id" TEXT;

UPDATE "triggers"
SET "token_preview" = '••••••••'
WHERE "token_preview" IS NULL;

ALTER TABLE "webhook_events"
  ADD COLUMN "method" TEXT NOT NULL DEFAULT 'POST',
  ADD COLUMN "query_json" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "webhook_replay_nonces" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_replay_nonces_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "webhook_replay_nonces"
  ADD CONSTRAINT "webhook_replay_nonces_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_replay_nonces"
  ADD CONSTRAINT "webhook_replay_nonces_trigger_id_fkey"
  FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "triggers"
  ADD CONSTRAINT "triggers_last_execution_id_fkey"
  FOREIGN KEY ("last_execution_id") REFERENCES "executions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "webhook_replay_nonces_organization_id_trigger_id_nonce_key"
  ON "webhook_replay_nonces"("organization_id", "trigger_id", "nonce");

CREATE INDEX "webhook_replay_nonces_expires_at_idx"
  ON "webhook_replay_nonces"("expires_at");

CREATE INDEX "triggers_id_enabled_deleted_at_idx"
  ON "triggers"("id", "enabled", "deleted_at");

CREATE INDEX "triggers_token_hash_idx"
  ON "triggers"("token_hash");

CREATE INDEX "triggers_organization_id_workflow_id_idx"
  ON "triggers"("organization_id", "workflow_id");
