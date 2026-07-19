"use client";

import Link from "next/link";
import { use, useState } from "react";
import { ErrorMessage } from "../../../components/error-message";
import { StatusBadge } from "../../../components/status-badge";
import { RequireAuth } from "../../../features/auth/require-auth";
import { canRetryExecution } from "../../../features/auth/rbac";
import { useAuth } from "../../../features/auth/use-auth";
import { RetryExecutionDialog } from "../../../features/dead-letter-executions/components/retry-execution-dialog";
import { reasonDescriptions, reasonLabels } from "../../../features/dead-letter-executions/reasons";
import { useDeadLetterExecution } from "../../../features/dead-letter-executions/hooks";

export default function DeadLetterExecutionDetailPage({ params }: { params: Promise<{ deadLetterId: string }> }) {
  const { deadLetterId } = use(params);
  const query = useDeadLetterExecution(deadLetterId);
  const detail = query.data;
  const [retryOpen, setRetryOpen] = useState(false);
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;

  return (
    <RequireAuth>
      <main className="content stack">
        {query.error && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
        {query.isLoading && <p className="muted">Loading dead letter...</p>}
        {detail && (
          <>
            <section className="panel stack">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <h1>Dead letter detail</h1>
                  <p className="muted">{detail.id}</p>
                </div>
                <StatusBadge status={detail.active ? "DLQ ACTIVE" : "DLQ RESOLVED"} />
              </div>
              <p>
                <strong>{reasonLabels[detail.reason]}</strong>: {reasonDescriptions[detail.reason]}
              </p>
              <p>Created: {formatDate(detail.createdAt)}</p>
              <p>Workflow: {detail.workflow.name}</p>
              <p>Version: {detail.workflowVersion.versionNumber}</p>
              <p>
                Original execution: <Link href={`/executions/${detail.executionId}`}>{detail.executionId}</Link>
              </p>
              <p>Failed step: {detail.failedStepKey ?? "-"}</p>
              <p>Attempts: {detail.attempts}</p>
              <p>
                Correlation: <code>{detail.correlationId ?? "-"}</code>{" "}
                {detail.correlationId && (
                  <button type="button" onClick={() => navigator.clipboard.writeText(detail.correlationId ?? "")}>
                    Copy
                  </button>
                )}
              </p>
              {detail.active && canRetryExecution(role) && (
                <button type="button" onClick={() => setRetryOpen(true)}>
                  Retry execution
                </button>
              )}
              {detail.active && !canRetryExecution(role) && <p className="muted">Your role can view this failure but cannot request retry.</p>}
            </section>

            <section className="panel stack">
              <h2>Last error</h2>
              <p>
                <strong>{detail.lastError.code}</strong> {detail.lastError.messageSafe}
              </p>
              <p className="muted">Category: {detail.lastError.category}</p>
            </section>

            <section className="panel stack">
              <h2>Resolution</h2>
              <p>{detail.resolution ?? "Unresolved"}</p>
              {detail.resolvedAt && <p>Resolved: {formatDate(detail.resolvedAt)}</p>}
              {detail.retryExecution && (
                <p>
                  Retry execution: <Link href={`/executions/${detail.retryExecution.id}`}>{detail.retryExecution.id}</Link>
                </p>
              )}
            </section>

            <RetryExecutionDialog open={retryOpen} executionId={detail.executionId} deadLetterId={detail.id} onClose={() => setRetryOpen(false)} />
          </>
        )}
      </main>
    </RequireAuth>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
