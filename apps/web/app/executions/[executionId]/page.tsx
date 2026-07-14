"use client";

import { use } from "react";
import { ErrorMessage } from "../../../components/error-message";
import { JsonViewer } from "../../../components/json-viewer";
import { StatusBadge } from "../../../components/status-badge";
import { RequireAuth } from "../../../features/auth/require-auth";
import { useExecution } from "../../../features/executions/hooks";

export default function ExecutionDetailPage({ params }: { params: Promise<{ executionId: string }> }) {
  const { executionId } = use(params);
  const execution = useExecution(executionId);
  const detail = execution.data;

  return (
    <RequireAuth>
      <main className="content stack">
        {execution.error && <ErrorMessage error={execution.error} onRetry={() => execution.refetch()} />}
        {execution.isLoading && <p className="muted">Loading execution...</p>}
        {detail && (
          <>
            <section className="panel stack">
              <h1>Execution</h1>
              <StatusBadge status={detail.status} />
              <p className="muted">{detail.id}</p>
              <p>Workflow: {detail.workflow.name}</p>
              <p>Version: {detail.workflowVersion.versionNumber}</p>
              <p>Duration: {duration(detail.startedAt, detail.completedAt)}</p>
              <p>Created: {formatDate(detail.createdAt)}</p>
            </section>

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
                    <StatusBadge status={step.status} />
                  </div>
                  <p>Attempt: {step.attempt}</p>
                  <p>Duration: {step.durationMs ?? 0} ms</p>
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
          </>
        )}
      </main>
    </RequireAuth>
  );
}

function duration(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return "-";
  }
  return `${Math.max(0, new Date(end).getTime() - new Date(start).getTime())} ms`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
