CREATE TYPE "InternalEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'DEAD');
CREATE TYPE "InternalEventDeliveryStatus" AS ENUM ('PENDING', 'MATERIALIZED', 'SKIPPED');

ALTER TABLE "triggers" ADD COLUMN "event_type" TEXT;
ALTER TABLE "executions" ADD COLUMN "event_delivery_id" TEXT,
ADD COLUMN "event_root_id" TEXT,
ADD COLUMN "event_causation_id" TEXT,
ADD COLUMN "event_depth" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "internal_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "envelope_json" JSONB NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "root_event_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "correlation_id" TEXT NOT NULL,
  "depth" INTEGER NOT NULL DEFAULT 0,
  "status" "InternalEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "locked_until" TIMESTAMP(3),
  "matching_completed_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "dead_lettered_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "internal_event_chains" (
  "root_event_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "event_count" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_event_chains_pkey" PRIMARY KEY ("root_event_id")
);

CREATE TABLE "internal_event_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "internal_event_id" TEXT NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "execution_id" TEXT,
  "status" "InternalEventDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" TEXT,
  "materialized_at" TIMESTAMP(3),
  "enqueued_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_event_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "executions_event_delivery_id_key" ON "executions"("event_delivery_id");
CREATE INDEX "executions_organization_id_event_root_id_idx" ON "executions"("organization_id", "event_root_id");
CREATE INDEX "triggers_organization_id_type_event_type_enabled_deleted_at_idx" ON "triggers"("organization_id", "type", "event_type", "enabled", "deleted_at");
CREATE INDEX "internal_events_status_next_attempt_at_locked_until_occurred_at_idx" ON "internal_events"("status", "next_attempt_at", "locked_until", "occurred_at");
CREATE INDEX "internal_events_organization_id_event_type_occurred_at_idx" ON "internal_events"("organization_id", "event_type", "occurred_at");
CREATE INDEX "internal_events_organization_id_root_event_id_idx" ON "internal_events"("organization_id", "root_event_id");
CREATE INDEX "internal_event_chains_organization_id_updated_at_idx" ON "internal_event_chains"("organization_id", "updated_at");
CREATE UNIQUE INDEX "internal_event_deliveries_internal_event_id_trigger_id_key" ON "internal_event_deliveries"("internal_event_id", "trigger_id");
CREATE UNIQUE INDEX "internal_event_deliveries_execution_id_key" ON "internal_event_deliveries"("execution_id");
CREATE INDEX "internal_event_deliveries_organization_id_status_created_at_idx" ON "internal_event_deliveries"("organization_id", "status", "created_at");

ALTER TABLE "internal_events" ADD CONSTRAINT "internal_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_event_chains" ADD CONSTRAINT "internal_event_chains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_event_deliveries" ADD CONSTRAINT "internal_event_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_event_deliveries" ADD CONSTRAINT "internal_event_deliveries_internal_event_id_fkey" FOREIGN KEY ("internal_event_id") REFERENCES "internal_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_event_deliveries" ADD CONSTRAINT "internal_event_deliveries_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executions" ADD CONSTRAINT "executions_event_delivery_id_fkey" FOREIGN KEY ("event_delivery_id") REFERENCES "internal_event_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
