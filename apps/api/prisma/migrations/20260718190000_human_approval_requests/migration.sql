CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

ALTER TABLE "executions" ADD COLUMN "wait_reason" TEXT;

CREATE TABLE "approval_requests" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "execution_id" TEXT NOT NULL,
  "step_execution_id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "workflow_version_id" TEXT,
  "step_key" TEXT NOT NULL,
  "execution_path" TEXT NOT NULL DEFAULT 'root',
  "iteration_index" INTEGER,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "summary" TEXT,
  "assignee_policy" TEXT NOT NULL DEFAULT 'ANY_AUTHORIZED_USER',
  "allowed_roles" TEXT[] NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "decided_at" TIMESTAMP(3),
  "decided_by_user_id" TEXT,
  "decision" "ApprovalDecision",
  "decision_comment" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "approval_requests_step_execution_id_key" ON "approval_requests"("step_execution_id");
CREATE INDEX "approval_requests_organization_id_status_requested_at_idx" ON "approval_requests"("organization_id", "status", "requested_at");
CREATE INDEX "approval_requests_execution_id_idx" ON "approval_requests"("execution_id");
CREATE INDEX "approval_requests_status_expires_at_idx" ON "approval_requests"("status", "expires_at");
CREATE INDEX "approval_requests_organization_id_workflow_id_requested_at_idx" ON "approval_requests"("organization_id", "workflow_id", "requested_at");
CREATE INDEX "approval_requests_decided_by_user_id_idx" ON "approval_requests"("decided_by_user_id");
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_step_execution_id_fkey" FOREIGN KEY ("step_execution_id") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_version_id_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
