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
  const executions = useExecutions({ page, pageSize: 20, workflowId, status });
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
                    <th>Duration</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.data.items.map((execution) => (
                    <tr key={execution.id}>
                      <td>
                        <StatusBadge status={execution.status} />
                      </td>
                      <td>
                        <Link href={`/executions/${execution.id}`}>{execution.id}</Link>
                      </td>
                      <td>{execution.workflowId}</td>
                      <td>{duration(execution.startedAt, execution.completedAt)}</td>
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

function duration(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return "-";
  }
  return `${Math.max(0, new Date(end).getTime() - new Date(start).getTime())} ms`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
