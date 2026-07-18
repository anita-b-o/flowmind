CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER', 'CANCELLED');
CREATE TYPE "NotificationErrorCategory" AS ENUM ('TRANSIENT', 'INVALID_RECIPIENT', 'TEMPLATE', 'CONFIGURATION', 'PROVIDER_REJECTED', 'UNKNOWN');

CREATE TABLE "notification_rules" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "connection_id" TEXT NOT NULL,
  "recipient_config_json" JSONB NOT NULL,
  "filters_json" JSONB NOT NULL DEFAULT '{}',
  "template_key" TEXT NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_requests" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "notification_rule_id" TEXT NOT NULL,
  "source_event_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "template_key" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "correlation_id" TEXT,
  "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_attempt_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "locked_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "notification_request_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'smtp',
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "provider_message_id" TEXT,
  "error_category" "NotificationErrorCategory",
  "error_message_safe" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_rules_organization_id_enabled_event_type_deleted_at_idx" ON "notification_rules"("organization_id", "enabled", "event_type", "deleted_at");
CREATE INDEX "notification_rules_organization_id_connection_id_idx" ON "notification_rules"("organization_id", "connection_id");
CREATE UNIQUE INDEX "notification_requests_organization_id_idempotency_key_key" ON "notification_requests"("organization_id", "idempotency_key");
CREATE INDEX "notification_requests_organization_id_status_created_at_idx" ON "notification_requests"("organization_id", "status", "created_at");
CREATE INDEX "notification_requests_status_scheduled_at_next_attempt_at_locked_until_idx" ON "notification_requests"("status", "scheduled_at", "next_attempt_at", "locked_until");
CREATE INDEX "notification_requests_source_event_id_idx" ON "notification_requests"("source_event_id");
CREATE UNIQUE INDEX "notification_deliveries_notification_request_id_key" ON "notification_deliveries"("notification_request_id");
CREATE INDEX "notification_deliveries_organization_id_status_created_at_idx" ON "notification_deliveries"("organization_id", "status", "created_at");

ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_requests" ADD CONSTRAINT "notification_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_requests" ADD CONSTRAINT "notification_requests_notification_rule_id_fkey" FOREIGN KEY ("notification_rule_id") REFERENCES "notification_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_request_id_fkey" FOREIGN KEY ("notification_request_id") REFERENCES "notification_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
