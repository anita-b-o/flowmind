CREATE TABLE "organization_variables" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_variables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_variables" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_variables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_variables_organization_id_key_key" ON "organization_variables"("organization_id", "key");
CREATE INDEX "organization_variables_organization_id_idx" ON "organization_variables"("organization_id");
CREATE UNIQUE INDEX "workflow_variables_workflow_id_key_key" ON "workflow_variables"("workflow_id", "key");
CREATE INDEX "workflow_variables_organization_id_workflow_id_idx" ON "workflow_variables"("organization_id", "workflow_id");

ALTER TABLE "organization_variables" ADD CONSTRAINT "organization_variables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_variables" ADD CONSTRAINT "workflow_variables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_variables" ADD CONSTRAINT "workflow_variables_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
