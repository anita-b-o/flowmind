ALTER TABLE "workflow_versions"
ADD COLUMN "restored_from_version_id" TEXT,
ADD COLUMN "materialized_trigger_snapshot_json" JSONB;

CREATE INDEX "workflow_versions_restored_from_version_id_idx"
ON "workflow_versions"("restored_from_version_id");

ALTER TABLE "workflow_versions"
ADD CONSTRAINT "workflow_versions_restored_from_version_id_fkey"
FOREIGN KEY ("restored_from_version_id") REFERENCES "workflow_versions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION flowmind_protect_workflow_version_snapshot()
RETURNS trigger AS $$
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."workflow_id" IS DISTINCT FROM OLD."workflow_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."definition_json" IS DISTINCT FROM OLD."definition_json"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."restored_from_version_id" IS DISTINCT FROM OLD."restored_from_version_id"
    OR NEW."materialized_trigger_snapshot_json" IS DISTINCT FROM OLD."materialized_trigger_snapshot_json"
  THEN
    RAISE EXCEPTION 'workflow version snapshots are immutable';
  END IF;
  IF OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at" THEN
    RAISE EXCEPTION 'published timestamp is immutable';
  END IF;
  IF OLD."status" = 'ARCHIVED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'archived workflow versions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workflow_version_snapshot_immutable"
BEFORE UPDATE ON "workflow_versions"
FOR EACH ROW EXECUTE FUNCTION flowmind_protect_workflow_version_snapshot();

CREATE OR REPLACE FUNCTION flowmind_protect_published_workflow_step()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "workflow_versions"
    WHERE "id" = OLD."workflow_version_id" AND "status" IN ('ACTIVE', 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'published workflow steps are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "published_workflow_step_immutable"
BEFORE UPDATE ON "workflow_steps"
FOR EACH ROW EXECUTE FUNCTION flowmind_protect_published_workflow_step();
