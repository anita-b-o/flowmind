CREATE TABLE "data_stores" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "data_stores_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "data_store_records" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "data_store_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value_json" JSONB NOT NULL,
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "expires_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "data_store_records_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "data_stores"
  ADD CONSTRAINT "data_stores_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "data_store_records"
  ADD CONSTRAINT "data_store_records_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "data_store_records"
  ADD CONSTRAINT "data_store_records_data_store_id_fkey"
  FOREIGN KEY ("data_store_id") REFERENCES "data_stores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "data_stores_org_lower_name_active_key"
  ON "data_stores"("organization_id", lower("name"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "data_store_records_store_key_active_key"
  ON "data_store_records"("data_store_id", "key")
  WHERE "deleted_at" IS NULL;

CREATE INDEX "data_stores_organization_id_deleted_at_updated_at_idx"
  ON "data_stores"("organization_id", "deleted_at", "updated_at");

CREATE INDEX "data_store_records_organization_id_data_store_id_deleted_at_key_idx"
  ON "data_store_records"("organization_id", "data_store_id", "deleted_at", "key");

CREATE INDEX "data_store_records_data_store_id_expires_at_deleted_at_idx"
  ON "data_store_records"("data_store_id", "expires_at", "deleted_at");
