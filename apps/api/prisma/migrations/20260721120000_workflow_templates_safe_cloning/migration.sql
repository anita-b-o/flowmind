CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "workflow_templates" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "WorkflowTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_template_versions" (
  "id" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "version_number" INTEGER NOT NULL,
  "definition_json" JSONB NOT NULL,
  "dependency_manifest_json" JSONB NOT NULL,
  "source_workflow_id" TEXT,
  "source_workflow_version_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "workflow_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflow_templates_organization_id_status_updated_at_idx" ON "workflow_templates"("organization_id", "status", "updated_at");
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_number_key" ON "workflow_template_versions"("template_id", "version_number");
CREATE INDEX "workflow_template_versions_template_id_published_at_idx" ON "workflow_template_versions"("template_id", "published_at");
CREATE INDEX "workflow_template_versions_source_workflow_id_idx" ON "workflow_template_versions"("source_workflow_id");
CREATE INDEX "workflow_template_versions_source_workflow_version_id_idx" ON "workflow_template_versions"("source_workflow_version_id");

ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_source_workflow_id_fkey" FOREIGN KEY ("source_workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_source_workflow_version_id_fkey" FOREIGN KEY ("source_workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION flowmind_protect_workflow_template_version_snapshot()
RETURNS trigger AS $$
BEGIN
  IF NEW."template_id" IS DISTINCT FROM OLD."template_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."definition_json" IS DISTINCT FROM OLD."definition_json"
    OR NEW."dependency_manifest_json" IS DISTINCT FROM OLD."dependency_manifest_json"
    OR NEW."source_workflow_id" IS DISTINCT FROM OLD."source_workflow_id"
    OR NEW."source_workflow_version_id" IS DISTINCT FROM OLD."source_workflow_version_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'workflow template version snapshots are immutable';
  END IF;
  IF OLD."published_at" IS NOT NULL AND NEW."published_at" IS DISTINCT FROM OLD."published_at" THEN
    RAISE EXCEPTION 'published template timestamp is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workflow_template_version_snapshot_immutable"
BEFORE UPDATE ON "workflow_template_versions"
FOR EACH ROW EXECUTE FUNCTION flowmind_protect_workflow_template_version_snapshot();
