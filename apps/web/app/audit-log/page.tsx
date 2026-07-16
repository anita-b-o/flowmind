"use client";

import { useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { JsonViewer } from "../../components/json-viewer";
import { Pagination } from "../../components/pagination";
import { RequireAuth } from "../../features/auth/require-auth";
import { canViewAuditLog } from "../../features/auth/rbac";
import { useAuth } from "../../features/auth/use-auth";
import { useAuditLogs } from "../../features/audit-log/hooks";
import type { AuditLogFilters } from "../../features/audit-log/types";

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const query = useAuditLogs(filters, page);
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;

  return (
    <RequireAuth>
      <main className="content stack">
        <h1>Audit log</h1>
        {!canViewAuditLog(role) && <section className="panel">Only owners and admins can view the audit log.</section>}
        {canViewAuditLog(role) && (
          <>
            <section className="panel stack">
              <div className="grid">
                <label>
                  Action
                  <input
                    value={filters.action ?? ""}
                    onChange={(event) => {
                      setFilters({ ...filters, action: event.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <label>
                  Resource type
                  <input
                    value={filters.resourceType ?? ""}
                    onChange={(event) => {
                      setFilters({ ...filters, resourceType: event.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <label>
                  From
                  <input
                    type="date"
                    value={filters.from ?? ""}
                    onChange={(event) => {
                      setFilters({ ...filters, from: event.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={filters.to ?? ""}
                    onChange={(event) => {
                      setFilters({ ...filters, to: event.target.value });
                      setPage(1);
                    }}
                  />
                </label>
              </div>
            </section>
            {query.error && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
            <section className="panel stack">
              {query.isLoading && <p className="muted">Loading audit log...</p>}
              {!query.isLoading && !query.data?.items.length && <p className="muted">No audit events match these filters.</p>}
              {!!query.data?.items.length && (
                <>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Resource</th>
                        <th>Correlation</th>
                        <th>Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.items.map((item) => (
                        <tr key={item.id}>
                          <td>{formatDate(item.createdAt)}</td>
                          <td>{item.actor?.display ?? "System"}</td>
                          <td>{item.action}</td>
                          <td>
                            {item.resourceType} {item.resourceId.slice(0, 8)}
                          </td>
                          <td>{item.correlationId ?? "-"}</td>
                          <td>
                            <details>
                              <summary>{summary(item.metadata)}</summary>
                              <JsonViewer value={item.metadata} />
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={setPage} />
                </>
              )}
            </section>
          </>
        )}
      </main>
    </RequireAuth>
  );
}

function summary(value: unknown) {
  if (!value || typeof value !== "object") return "No metadata";
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 2);
  return entries.length ? entries.map(([key, entry]) => `${key}: ${String(entry).slice(0, 40)}`).join(", ") : "No metadata";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
