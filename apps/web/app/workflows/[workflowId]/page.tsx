"use client";

import { use, useEffect, useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorMessage } from "../../../components/error-message";
import { OneTimeSecretPanel, type OneTimeSecret } from "../../../components/one-time-secret-panel";
import { StatusBadge } from "../../../components/status-badge";
import { RequireAuth } from "../../../features/auth/require-auth";
import { useCreateWebhookTrigger, useRotateWebhookTrigger, useTriggers } from "../../../features/triggers/hooks";
import { useWorkflow } from "../../../features/workflows/hooks";
import { WorkflowEditor } from "../../../features/workflows/components/workflow-editor";

export default function WorkflowDetailPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = use(params);
  const workflow = useWorkflow(workflowId);
  const triggers = useTriggers(workflowId);
  const createTrigger = useCreateWebhookTrigger(workflowId);
  const rotateTrigger = useRotateWebhookTrigger(workflowId);
  const resetCreateTrigger = createTrigger.reset;
  const resetRotateTrigger = rotateTrigger.reset;
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [rotateId, setRotateId] = useState<string | null>(null);

  useEffect(
    () => () => {
      setSecret(null);
      resetCreateTrigger();
      resetRotateTrigger();
    },
    [resetCreateTrigger, resetRotateTrigger]
  );

  async function onCreate() {
    const result = await createTrigger.mutateAsync();
    setSecret({ token: result.token, webhookUrl: result.webhookUrl });
    createTrigger.reset();
  }

  async function onRotate() {
    if (!rotateId) {
      return;
    }
    const result = await rotateTrigger.mutateAsync(rotateId);
    setSecret({ token: result.token, webhookUrl: result.webhookUrl });
    rotateTrigger.reset();
    setRotateId(null);
  }

  return (
    <RequireAuth>
      <main className="content stack">
        <section className="panel stack">
          <h1>{workflow.data?.name ?? "Workflow"}</h1>
          {workflow.data && <StatusBadge status={workflow.data.status} />}
          {workflow.error && <ErrorMessage error={workflow.error} onRetry={() => workflow.refetch()} />}
        </section>

        {workflow.data && <WorkflowEditor workflow={workflow.data} onRefresh={() => workflow.refetch()} />}

        <section className="panel stack">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <div>
              <h2>Webhook triggers</h2>
              <p className="muted">Tokens are only shown when created or rotated.</p>
            </div>
            <button type="button" onClick={onCreate} disabled={createTrigger.isPending}>
              Create webhook trigger
            </button>
          </div>
          {triggers.error && <ErrorMessage error={triggers.error} onRetry={() => triggers.refetch()} />}
          {triggers.isLoading && <p className="muted">Loading triggers...</p>}
          {!triggers.isLoading && !triggers.data?.length && <p className="muted">No triggers yet.</p>}
          {triggers.data?.map((trigger) => (
            <div className="panel stack" key={trigger.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <strong>{trigger.type}</strong>
                  <p className="muted">Created {formatDate(trigger.createdAt)}</p>
                  <p className="muted">Rotated {trigger.rotatedAt ? formatDate(trigger.rotatedAt) : "never"}</p>
                </div>
                <button type="button" onClick={() => setRotateId(trigger.id)}>
                  Rotate
                </button>
              </div>
            </div>
          ))}
        </section>
      </main>
      <OneTimeSecretPanel secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={Boolean(rotateId)}
        title="Rotate webhook token"
        description="The current token will stop working immediately. The new token will be shown once."
        confirmLabel="Rotate token"
        onCancel={() => setRotateId(null)}
        onConfirm={onRotate}
      />
    </RequireAuth>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
