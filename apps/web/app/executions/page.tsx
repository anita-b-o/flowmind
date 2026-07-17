"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { Pagination } from "../../components/pagination";
import { StatusBadge } from "../../components/status-badge";
import { RequireAuth } from "../../features/auth/require-auth";
import { EXECUTION_STATUSES, type ExecutionStatus } from "../../features/executions/types";
import { useExecutions } from "../../features/executions/hooks";
import { useWorkflows } from "../../features/workflows/hooks";

export default function ExecutionsPage() {
  const [page, setPage] = useState(1);
  const [workflowId, setWorkflowId] = useState("");
  const [status, setStatus] = useState<ExecutionStatus | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const executions = useExecutions({ page, pageSize: 20, workflowId, status, from, to });
  const workflows = useWorkflows();

  return (
    <RequireAuth>
      <main className="content stack">
        <h1>Execution History</h1>
        <section className="panel stack">
          <div className="grid">
            <label>
              Workflow
              <select
                value={workflowId}
                onChange={(event) => {
                  setWorkflowId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All workflows</option>
                {workflows.data?.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ExecutionStatus | "");
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {EXECUTION_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <div style={{ alignSelf: "end" }}>
              <button type="button" onClick={() => executions.refetch()}>
                Refresh
              </button>
            </div>
          </div>
        </section>
        {executions.error && <ErrorMessage error={executions.error} onRetry={() => executions.refetch()} />}
        <section className="panel stack">
          {executions.isLoading && <p className="muted">Loading executions...</p>}
          {!executions.isLoading && !executions.data?.items.length && <p className="muted">No executions match these filters.</p>}
          {!!executions.data?.items.length && (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Execution</th>
                    <th>Workflow</th>
                    <th>Version</th>
                    <th>Steps</th>
                    <th>Initiator</th>
                    <th>Duration</th>
                    <th>Started</th>
                    <th>Finished</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.data.items.map((execution) => (
                    <tr key={execution.id}>
                      <td>
                        <StatusBadge status={execution.publicStatus ?? execution.status} />
                      </td>
                      <td>
                        <Link href={`/executions/${execution.id}`}>{execution.id}</Link>
                      </td>
                      <td>{execution.workflowName ?? execution.workflow?.name ?? execution.workflowId}</td>
                      <td>{execution.versionNumber ?? execution.workflowVersion?.versionNumber ?? "-"}</td>
                      <td>
                        {(execution.completedStepCount ?? 0)}/{execution.stepCount ?? 0}
                        {(execution.failedStepCount ?? 0) > 0 ? ` failed ${execution.failedStepCount}` : ""}
                      </td>
                      <td>{execution.initiator?.display ?? "-"}</td>
                      <td>{formatDuration(execution.durationMs, execution.startedAt, execution.finishedAt ?? execution.completedAt)}</td>
                      <td>{execution.startedAt ? formatDate(execution.startedAt) : "-"}</td>
                      <td>{execution.finishedAt ? formatDate(execution.finishedAt) : "-"}</td>
                      <td>{formatDate(execution.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination
                page={executions.data.page}
                pageSize={executions.data.pageSize}
                total={executions.data.total}
                onPageChange={setPage}
              />
            </>
          )}
        </section>
      </main>
    </RequireAuth>
  );
}

function formatDuration(value?: number | null, start?: string | null, end?: string | null) {
  if (typeof value === "number") return `${value} ms`;
  if (!start || !end) {
    return "-";
  }
  return `${Math.max(0, new Date(end).getTime() - new Date(start).getTime())} ms`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
