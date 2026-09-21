"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "../../components/brand";
import { ErrorMessage } from "../../components/error-message";
import { LoadingState } from "../../components/loading-state";
import { Pagination } from "../../components/pagination";
import { RequireAuth } from "../../features/auth/require-auth";
import { useApprovals } from "../../features/approvals/hooks";
import type { ApprovalStatus } from "../../features/approvals/types";

export default function ApprovalsPage() {
  const [status, setStatus] = useState<ApprovalStatus | "">("PENDING");
  const [page, setPage] = useState(1);
  const query = useApprovals(status, page);

  return <RequireAuth><main className="content stack">
    <header className="page-header"><div><h1>Approvals</h1><p className="muted">Review requests waiting for a decision and their outcomes.</p></div></header>
    <section className="panel stack"><label>Status<select value={status} onChange={(event) => { setStatus(event.target.value as ApprovalStatus | ""); setPage(1); }}><option value="">All</option>{["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"].map((value) => <option key={value}>{value}</option>)}</select></label></section>
    {query.error && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
    <section className="panel stack">
      {query.isLoading && <LoadingState label="Loading approvals..." />}
      {!query.isLoading && !query.error && !query.data?.items.length && <EmptyState title="No approvals found"><p>Approval requests appear here when a running workflow reaches an approval step. Choose All to view past decisions.</p></EmptyState>}
      {!!query.data?.items.length && <><table className="table"><thead><tr><th>Title</th><th>Workflow</th><th>Execution</th><th>Requested</th><th>Expires</th><th>Status</th></tr></thead><tbody>{query.data.items.map((item) => <tr key={item.id}><td><Link href={`/approvals/${item.id}`}>{item.title}</Link></td><td>{item.workflow.name}</td><td><Link href={`/executions/${item.executionId}`}>{item.executionId.slice(0, 8)}</Link></td><td>{new Date(item.requestedAt).toLocaleString()}</td><td>{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "Never"}</td><td>{item.status}</td></tr>)}</tbody></table><Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={setPage} /></>}
    </section>
  </main></RequireAuth>;
}
