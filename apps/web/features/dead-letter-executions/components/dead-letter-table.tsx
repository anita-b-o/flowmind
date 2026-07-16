"use client";

import Link from "next/link";
import { StatusBadge } from "../../../components/status-badge";
import { reasonLabels } from "../reasons";
import type { DeadLetterSummary } from "../types";

export function DeadLetterTable({ items }: { items: DeadLetterSummary[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>State</th>
          <th>Reason</th>
          <th>Workflow</th>
          <th>Execution</th>
          <th>Failed step</th>
          <th>Attempts</th>
          <th>Created</th>
          <th>Resolution</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              <StatusBadge status={item.active ? "DLQ ACTIVE" : "DLQ RESOLVED"} />
            </td>
            <td>
              <Link href={`/dead-letter-executions/${item.id}`}>{reasonLabels[item.reason]}</Link>
            </td>
            <td>{item.workflowName ?? item.workflowId}</td>
            <td>
              <Link href={`/executions/${item.executionId}`}>{shortId(item.executionId)}</Link>
            </td>
            <td>{item.failedStepKey ?? "-"}</td>
            <td>{item.attempts}</td>
            <td>{formatDate(item.createdAt)}</td>
            <td>{item.resolution ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
