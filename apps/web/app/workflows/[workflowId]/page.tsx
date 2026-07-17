"use client";

import { use, useState } from "react";
import { ErrorMessage } from "../../../components/error-message";
import { OneTimeSecretPanel, type OneTimeSecret } from "../../../components/one-time-secret-panel";
import { StatusBadge } from "../../../components/status-badge";
import { RequireAuth } from "../../../features/auth/require-auth";
import { canRunWorkflow } from "../../../features/auth/rbac";
import { useAuth } from "../../../features/auth/use-auth";
import { RunWorkflowDialog } from "../../../features/executions/components/run-workflow-dialog";
import { ScheduledTriggersPanel } from "../../../features/triggers/scheduled-triggers-panel";
import { WebhookTriggersPanel } from "../../../features/triggers/webhook-triggers-panel";
import { useWorkflow } from "../../../features/workflows/hooks";
import { WorkflowEditor } from "../../../features/workflows/components/workflow-editor";

export default function WorkflowDetailPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = use(params);
  const workflow = useWorkflow(workflowId);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;

  return (
    <RequireAuth>
      <main className="content stack">
        <section className="panel stack">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
            <div>
              <h1>{workflow.data?.name ?? "Workflow"}</h1>
              {workflow.data && <StatusBadge status={workflow.data.status} />}
            </div>
            {workflow.data?.activeVersionId && workflow.data.status === "ACTIVE" && canRunWorkflow(role) && (
              <button type="button" onClick={() => setRunOpen(true)}>
                Run
              </button>
            )}
          </div>
          {workflow.error && <ErrorMessage error={workflow.error} onRetry={() => workflow.refetch()} />}
        </section>

        {workflow.data && <WorkflowEditor workflow={workflow.data} onRefresh={() => workflow.refetch()} />}

        <WebhookTriggersPanel workflowId={workflowId} canManage={role === "owner" || role === "admin" || role === "editor"} onSecret={setSecret} />
        <ScheduledTriggersPanel workflowId={workflowId} canManage={role === "owner" || role === "admin" || role === "editor"} />
      </main>
      <OneTimeSecretPanel secret={secret} onClose={() => setSecret(null)} />
      {workflow.data && (
        <RunWorkflowDialog
          open={runOpen}
          workflowId={workflow.data.id}
          workflowName={workflow.data.name}
          onClose={() => setRunOpen(false)}
        />
      )}
    </RequireAuth>
  );
}
