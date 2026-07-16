ALTER TABLE "executions"
ADD COLUMN "correlation_id" TEXT;

ALTER TABLE "webhook_events"
ADD COLUMN "request_id" TEXT,
ADD COLUMN "correlation_id" TEXT;

ALTER TABLE "audit_logs"
ADD COLUMN "correlation_id" TEXT;

CREATE INDEX "executions_organization_id_correlation_id_idx"
ON "executions"("organization_id", "correlation_id");

CREATE INDEX "webhook_events_organization_id_correlation_id_idx"
ON "webhook_events"("organization_id", "correlation_id");

CREATE INDEX "audit_logs_organization_id_correlation_id_idx"
ON "audit_logs"("organization_id", "correlation_id");
