"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ErrorMessage } from "../../components/error-message";
import { StatusBadge } from "../../components/status-badge";
import { RequireAuth } from "../../features/auth/require-auth";
import { EXECUTION_STATUSES, type ExecutionStatus } from "../../features/executions/types";
import { useExecutions } from "../../features/executions/hooks";
import { useWorkflows } from "../../features/workflows/hooks";

export default function ExecutionsPage() {
  return <Suspense fallback={<main className="content stack"><p className="muted">Loading execution history...</p></main>}><ExecutionsPageContent /></Suspense>;
}

function ExecutionsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [cursors, setCursors] = useState<string[]>([]);
  const [workflowId, setWorkflowId] = useState(searchParams.get("workflowId") ?? "");
  const [status, setStatus] = useState<ExecutionStatus | "">((searchParams.get("status") as ExecutionStatus) ?? "");
  const [from, setFrom] = useState(searchParams.get("from") ?? "");
  const [to, setTo] = useState(searchParams.get("to") ?? "");
  const [triggerType, setTriggerType] = useState(searchParams.get("triggerType") ?? "");
  const [relationship, setRelationship] = useState(searchParams.get("relationship") ?? "all");
  const [waiting, setWaiting] = useState(searchParams.get("waiting") ?? "");
  const cursor = cursors.at(-1);
  const executions = useExecutions({ cursor, limit: 20, workflowId, status, from, to, triggerType, relationship, waiting });
  const workflows = useWorkflows();

  useEffect(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ workflowId, status, from, to, triggerType, relationship: relationship === "all" ? "" : relationship, waiting })) if (value) params.set(key, value);
    router.replace(`/executions${params.size ? `?${params}` : ""}`, { scroll: false });
  }, [workflowId, status, from, to, triggerType, relationship, waiting, router]);

  function resetCursor() { setCursors([]); }

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
                  resetCursor();
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
                  resetCursor();
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
              Trigger
              <select value={triggerType} onChange={(event) => { setTriggerType(event.target.value); resetCursor(); }}>
                <option value="">All triggers</option><option value="manual">Manual</option><option value="webhook">Webhook</option><option value="scheduled">Scheduled</option><option value="event">Event</option><option value="subworkflow">Subworkflow</option><option value="retry">Retry</option>
              </select>
            </label>
            <label>
              Relationship
              <select value={relationship} onChange={(event) => { setRelationship(event.target.value); resetCursor(); }}><option value="all">All</option><option value="root">Root</option><option value="child">Child</option></select>
            </label>
            <label>
              Waiting
              <select value={waiting} onChange={(event) => { setWaiting(event.target.value); resetCursor(); }}><option value="">All</option><option value="true">Waiting</option><option value="false">Not waiting</option></select>
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
                    <th>Trigger</th>
                    <th>Relation</th>
                    <th>Wait / failure</th>
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
                        <Link href={`/executions/${execution.id}`}>{execution.id.slice(0, 8)}…</Link>{" "}<button type="button" aria-label="Copy execution ID" onClick={() => navigator.clipboard.writeText(execution.id)}>Copy</button>
                      </td>
                      <td>{execution.workflowName ?? execution.workflow?.name ?? execution.workflowId}</td>
                      <td>{execution.triggerType ?? "manual"}</td>
                      <td>{execution.relationship ?? "root"} · depth {execution.depth ?? 0}</td>
                      <td>{execution.waitReason ? `Waiting: ${execution.waitReason}` : execution.failedStep ? `${execution.failedStep.errorHandled ? "Handled" : "Failed"}: ${execution.failedStep.stepKey}` : "-"}</td>
                      <td>{formatDuration(execution.durationMs, execution.startedAt, execution.finishedAt ?? execution.completedAt)}</td>
                      <td>{execution.startedAt ? formatDate(execution.startedAt) : "-"}</td>
                      <td>{execution.finishedAt ? formatDate(execution.finishedAt) : "-"}</td>
                      <td>{formatDate(execution.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="workflow-actions">
                <button type="button" disabled={!cursors.length} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</button>
                <button type="button" disabled={!executions.data.hasMore || !executions.data.nextCursor} onClick={() => executions.data?.nextCursor && setCursors((current) => [...current, executions.data!.nextCursor!])}>Next</button>
              </div>
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
