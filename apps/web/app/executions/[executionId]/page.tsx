"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ErrorMessage } from "../../../components/error-message";
import { JsonViewer } from "../../../components/json-viewer";
import { StatusBadge } from "../../../components/status-badge";
import { RequireAuth } from "../../../features/auth/require-auth";
import { useAuth } from "../../../features/auth/use-auth";
import { useCancelExecution, useExecution } from "../../../features/executions/hooks";
import { canCancelExecution, canRetryExecution } from "../../../features/auth/rbac";
import { RetryExecutionDialog } from "../../../features/dead-letter-executions/components/retry-execution-dialog";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ExecutionApprovalDetails } from "../../../features/executions/components/execution-approval-details";

export default function ExecutionDetailPage({ params }: { params: Promise<{ executionId: string }> }) {
  const { executionId } = use(params);
  const execution = useExecution(executionId);
  const detail = execution.data;
  const [retryOpen, setRetryOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;
  const cancelExecution = useCancelExecution(executionId);

  return (
    <RequireAuth>
      <main className="content stack">
        {execution.error && <ErrorMessage error={execution.error} onRetry={() => execution.refetch()} />}
        {execution.isLoading && <p className="muted">Loading execution...</p>}
        {detail && (
          <>
            <section className="panel stack">
              <h1>Execution</h1>
              <StatusBadge status={detail.publicStatus ?? detail.status} />
              {detail.deadLetter && <StatusBadge status={detail.deadLetter.active ? "DLQ ACTIVE" : "DLQ RESOLVED"} />}
              <p className="muted">{detail.id}</p>
              <p>Workflow: {detail.workflow.name}</p>
              <p>Version: {detail.workflowVersion?.versionNumber ?? "-"}</p>
              <p>Mode: {detail.mode ?? "REAL"}</p>
              <p>Subworkflow depth: {detail.depth}</p>
              {detail.parentExecution && <p>Parent: <Link href={`/executions/${detail.parentExecution.id}`}>{detail.parentExecution.id}</Link>{detail.parentStepExecution ? ` · ${detail.parentStepExecution.stepKey}` : ""}</p>}
              {detail.rootExecutionId !== detail.id && <p>Root: <Link href={`/executions/${detail.rootExecutionId}`}>{detail.rootExecutionId}</Link></p>}
              <p>Started by: {detail.initiator?.display ?? "-"}</p>
              <p>Duration: {formatDuration(detail.durationMs, detail.startedAt, detail.completedAt)}</p>
              <p>Created: {formatDate(detail.createdAt)}</p>
              <p>Started: {detail.startedAt ? formatDate(detail.startedAt) : "-"}</p>
              <p>Finished: {detail.finishedAt ? formatDate(detail.finishedAt) : "-"}</p>
              <p className="muted">Last updated: {execution.dataUpdatedAt ? formatDate(new Date(execution.dataUpdatedAt).toISOString()) : "-"}</p>
              {detail.workflowSnapshot && (
                <p>
                  Snapshot: version {detail.workflowSnapshot.versionNumber}, schema {detail.workflowSnapshot.definitionSchemaVersion}
                </p>
              )}
              {detail.cancelledAt && <p>Cancelled: {formatDate(detail.cancelledAt)}</p>}
              {detail.cancelReason && <p>Cancel reason: {detail.cancelReason}</p>}
              {detail.cancelRequestedBy && <p>Cancelled by: {detail.cancelRequestedBy.display}</p>}
              <p>
                Correlation: <code>{detail.correlationId ?? "-"}</code>{" "}
                {detail.correlationId && (
                  <button type="button" onClick={() => navigator.clipboard.writeText(detail.correlationId ?? "")}>
                    Copy
                  </button>
                )}
              </p>
              {detail.retryOfExecution && (
                <p>
                  Retry of: <Link href={`/executions/${detail.retryOfExecution.id}`}>{detail.retryOfExecution.id}</Link>
                </p>
              )}
              {detail.retryRequestedAt && <p>Retry requested: {formatDate(detail.retryRequestedAt)}</p>}
              {detail.retryReason && <p>Retry reason: {detail.retryReason}</p>}
              {detail.deadLetter && (
                <p>
                  Dead letter: <Link href={`/dead-letter-executions/${detail.deadLetter.id}`}>{detail.deadLetter.active ? "active" : "resolved"}</Link>
                </p>
              )}
              {(detail.status === "FAILED" || detail.deadLetter?.active) && canRetryExecution(role) && (
                <button type="button" onClick={() => setRetryOpen(true)}>
                  Retry execution
                </button>
              )}
              {["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(detail.status) && canCancelExecution(role) && (
                <button type="button" onClick={() => setCancelOpen(true)} disabled={cancelExecution.isPending}>
                  Cancel execution
                </button>
              )}
            </section>

            {!!detail.retryExecutions.length && (
              <section className="panel stack">
                <h2>Retries</h2>
                {detail.retryExecutions.map((retry) => (
                  <p key={retry.id}>
                    <StatusBadge status={retry.status} /> <Link href={`/executions/${retry.id}`}>{retry.id}</Link>
                  </p>
                ))}
              </section>
            )}

            {!!detail.childExecutions.length && <section className="panel stack"><h2>Child workflows</h2>{detail.childExecutions.map((child) => <p key={child.id}><StatusBadge status={child.status} /> <Link href={`/executions/${child.id}`}>{child.id}</Link> · depth {child.depth}</p>)}</section>}
            <ExecutionApprovalDetails waitReason={detail.waitReason} approvals={detail.approvals} />

            {detail.output !== null && detail.output !== undefined && <section className="panel stack"><h2>Workflow output</h2><JsonViewer value={detail.output} /></section>}

            {!!detail.deadLetters.length && (
              <section className="panel stack">
                <h2>Dead letters</h2>
                {detail.deadLetters.map((deadLetter) => (
                  <p key={deadLetter.id}>
                    <StatusBadge status={deadLetter.active ? "DLQ ACTIVE" : "DLQ RESOLVED"} />{" "}
                    <Link href={`/dead-letter-executions/${deadLetter.id}`}>{deadLetter.reason}</Link>
                  </p>
                ))}
              </section>
            )}

            <section className="panel stack">
              <h2>Trigger input</h2>
              <JsonViewer value={detail.input} />
            </section>

            <section className="panel stack">
              <h2>Execution context</h2>
              <JsonViewer value={detail.context} />
            </section>

            {detail.error && (
              <section className="panel stack">
                <h2>Error</h2>
                <JsonViewer value={detail.error} />
              </section>
            )}

            <section className="panel stack">
              <h2>Steps</h2>
              {detail.steps.map((step) => (
                <div className="panel stack" key={step.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <strong>{step.stepKey}</strong>
                      <p className="muted">{step.stepType}</p>
                    </div>
                    <StatusBadge status={step.publicStatus ?? step.status} />
                  </div>
                  <p>
                    Attempts: {step.attemptCount}/{step.maxAttempts}
                  </p>
                  {step.nextRetryAt && <p>Next retry: {formatDate(step.nextRetryAt)}</p>}
                  {step.effectStatus && (
                    <p>
                      Effect: <StatusBadge status={step.effectStatus === "ambiguous" ? "AMBIGUOUS EFFECT" : step.effectStatus.toUpperCase()} />
                    </p>
                  )}
                  {step.errorCategory && <p>Error category: {step.errorCategory}</p>}
                  <p>Duration: {step.durationMs ?? 0} ms</p>
                  {step.nextRetryAt && <p>Waiting until: {formatDate(step.nextRetryAt)}</p>}
                  {Boolean(step.providerMetadata) && (
                    <>
                      <h3>Provider metadata</h3>
                      <JsonViewer value={step.providerMetadata} />
                    </>
                  )}
                  <h3>Input</h3>
                  <JsonViewer value={step.input ?? null} />
                  <h3>Output</h3>
                  <JsonViewer value={step.output} />
                  {Boolean(step.error) && (
                    <>
                      <h3>Error</h3>
                      <JsonViewer value={step.error} />
                    </>
                  )}
                </div>
              ))}
            </section>
            <RetryExecutionDialog open={retryOpen} executionId={detail.id} deadLetterId={detail.deadLetter?.id} onClose={() => setRetryOpen(false)} />
            <ConfirmDialog
              open={cancelOpen}
              title="Cancel execution"
              description="No new steps will be started. Steps that already finished will remain visible."
              confirmLabel={cancelExecution.isPending ? "Cancelling..." : "Cancel execution"}
              onCancel={() => setCancelOpen(false)}
              onConfirm={async () => {
                try {
                  await cancelExecution.mutateAsync("Cancelled from execution detail");
                  setCancelOpen(false);
                } catch {
                  setCancelOpen(false);
                }
              }}
            />
          </>
        )}
      </main>
    </RequireAuth>
  );
}

function formatDuration(value?: number | null, start?: string | null, end?: string | null) {
  if (typeof value === "number") {
    return `${value} ms`;
  }
  if (!start || !end) {
    return "-";
  }
  return `${Math.max(0, new Date(end).getTime() - new Date(start).getTime())} ms`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
