ALTER TABLE "step_executions"
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "next_retry_at" TIMESTAMP(3),
ADD COLUMN "effect_key" TEXT,
ADD COLUMN "effect_status" TEXT,
ADD COLUMN "worker_id" TEXT;

UPDATE "step_executions"
SET
  "attempt_count" = GREATEST("attempt", 0),
  "max_attempts" = GREATEST("attempt", 1)
WHERE "attempt_count" = 0;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "execution_id", "workflow_step_id"
      ORDER BY "created_at" DESC, "updated_at" DESC, "id" DESC
    ) AS row_number
  FROM "step_executions"
)
DELETE FROM "step_executions"
WHERE "id" IN (
  SELECT "id" FROM ranked WHERE row_number > 1
);

CREATE UNIQUE INDEX "step_executions_execution_id_workflow_step_id_key"
ON "step_executions"("execution_id", "workflow_step_id");

ALTER TABLE "internal_records"
ADD COLUMN "dedupe_key" TEXT;

UPDATE "internal_records"
SET "dedupe_key" = "step_execution_id"
WHERE "dedupe_key" IS NULL;

ALTER TABLE "internal_records"
ALTER COLUMN "dedupe_key" SET NOT NULL;

WITH ranked_records AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "organization_id", "execution_id", "collection", "dedupe_key"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS row_number
  FROM "internal_records"
)
DELETE FROM "internal_records"
WHERE "id" IN (
  SELECT "id" FROM ranked_records WHERE row_number > 1
);

CREATE UNIQUE INDEX "internal_records_organization_id_execution_id_collection_dedupe_key_key"
ON "internal_records"("organization_id", "execution_id", "collection", "dedupe_key");
