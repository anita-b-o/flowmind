-- Connections and encrypted secrets MVP.

ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'REVOKED';
ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'DELETED';

CREATE TYPE "SecretStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "connections"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "rotated_at" TIMESTAMP(3),
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3);

ALTER TABLE "secrets"
  ADD COLUMN "encryption_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "key_id" TEXT,
  ADD COLUMN "status" "SecretStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "revoked_at" TIMESTAMP(3);

UPDATE "secrets"
SET "encryption_version" = COALESCE(NULLIF(regexp_replace("encryption_key_version", '[^0-9]', '', 'g'), '')::INTEGER, 1);

DELETE FROM "secrets" WHERE "connection_id" IS NULL;

ALTER TABLE "secrets" ALTER COLUMN "connection_id" SET NOT NULL;
ALTER TABLE "secrets" DROP COLUMN "encryption_key_version";

CREATE INDEX "connections_organization_id_type_status_idx" ON "connections"("organization_id", "type", "status");
CREATE INDEX "connections_organization_id_deleted_at_idx" ON "connections"("organization_id", "deleted_at");
CREATE UNIQUE INDEX "secrets_one_active_per_connection" ON "secrets"("connection_id") WHERE "status" = 'ACTIVE';
