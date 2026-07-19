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
import { EventTriggersPanel } from "../../../features/triggers/event-triggers-panel";
import { useWorkflow } from "../../../features/workflows/hooks";
import { useCloneWorkflow, useCloneWorkflowPreview } from "../../../features/templates/hooks";
import { useRouter } from "next/navigation";
import { WorkflowEditor } from "../../../features/workflows/components/workflow-editor";
import { VersionHistory } from "../../../features/workflows/components/version-history";

export default function WorkflowDetailPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = use(params);
  const router = useRouter();
  const workflow = useWorkflow(workflowId);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneVersionId, setCloneVersionId] = useState("");
  const [cloneName, setCloneName] = useState("");
  const clonePreview = useCloneWorkflowPreview(workflowId);
  const cloneWorkflow = useCloneWorkflow(workflowId);
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
            <div style={{display:"flex", gap:8}}>{canRunWorkflow(role) && workflow.data && <button type="button" onClick={() => { setCloneOpen(true); setCloneVersionId(workflow.data!.activeVersionId ?? workflow.data!.versions.at(-1)?.id ?? ""); setCloneName(`${workflow.data!.name} copy`); clonePreview.reset(); }}>Clone workflow</button>}{workflow.data?.activeVersionId && workflow.data.status === "ACTIVE" && canRunWorkflow(role) && (
              <button type="button" onClick={() => setRunOpen(true)}>
                Run
              </button>
            )}</div>
          </div>
          {workflow.error && <ErrorMessage error={workflow.error} onRetry={() => workflow.refetch()} />}
        </section>

        {workflow.data && <WorkflowEditor workflow={workflow.data} onRefresh={() => workflow.refetch()} />}
        {workflow.data && <VersionHistory workflowId={workflowId} role={role} onRefresh={() => workflow.refetch()} />}
        {cloneOpen && workflow.data && <section className="panel stack" role="dialog" aria-label="Clone workflow"><h2>Clone workflow</h2><p>Creates only a new workflow and Version 1 DRAFT. Secrets, history, executions, approvals, runtime state and active triggers are not copied.</p><label>Source version<select value={cloneVersionId} onChange={(event) => { setCloneVersionId(event.target.value); clonePreview.reset(); }}>{workflow.data.versions.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}</select></label><label>New workflow name<input value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label><button onClick={() => clonePreview.mutate({ sourceWorkflowVersionId: cloneVersionId, name: cloneName, mappings: [] })}>Preview clone</button>{clonePreview.error && <ErrorMessage error={clonePreview.error} onRetry={() => clonePreview.reset()} />}{clonePreview.data && <><p>{clonePreview.data.canInstantiate ? "Ready to clone." : "Clone is blocked."}</p>{clonePreview.data.warnings.map((warning) => <p className="form-warning" key={warning}>{warning}</p>)}{clonePreview.data.blockers.map((blocker, index) => <p role="alert" key={`${blocker.code}-${index}`}>{blocker.message}</p>)}<button disabled={!clonePreview.data.canInstantiate || cloneName.trim().length < 2 || cloneWorkflow.isPending} onClick={async () => { const cloned = await cloneWorkflow.mutateAsync({ sourceWorkflowVersionId: cloneVersionId, name: cloneName, mappings: [] }); router.push(`/workflows/${cloned.id}`); }}>Create clone</button></>}<button onClick={() => setCloneOpen(false)}>Cancel</button></section>}

        <WebhookTriggersPanel workflowId={workflowId} canManage={role === "owner" || role === "admin" || role === "editor"} onSecret={setSecret} />
        <ScheduledTriggersPanel workflowId={workflowId} canManage={role === "owner" || role === "admin" || role === "editor"} />
        <EventTriggersPanel workflowId={workflowId} canManage={role === "owner" || role === "admin" || role === "editor"} />
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
