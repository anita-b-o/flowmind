"use client";

import { useState } from "react";
import { EmptyState } from "../../components/brand";
import { LoadingState } from "../../components/loading-state";
import { ErrorMessage } from "../../components/error-message";
import { Pagination } from "../../components/pagination";
import { RequireAuth } from "../../features/auth/require-auth";
import { canViewDeadLetters } from "../../features/auth/rbac";
import { useAuth } from "../../features/auth/use-auth";
import { type DeadLetterFilters as Filters, useDeadLetterExecutions } from "../../features/dead-letter-executions/hooks";
import { DeadLetterFilters } from "../../features/dead-letter-executions/components/dead-letter-filters";
import { DeadLetterTable } from "../../features/dead-letter-executions/components/dead-letter-table";

export default function DeadLetterExecutionsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({ status: "active" });
  const query = useDeadLetterExecutions(filters, page);
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;

  return (
    <RequireAuth>
      <main className="content stack">
        <h1>Dead letters</h1>
        <p className="muted">Executions that failed permanently and require manual review.</p>
        {!canViewDeadLetters(role) && <section className="panel">You do not have permission to view dead letters.</section>}
        {canViewDeadLetters(role) && (
          <>
            <DeadLetterFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                setPage(1);
              }}
            />
            {query.error && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
            <section className="panel stack">
              {query.isLoading && <LoadingState label="Loading dead letters..." />}
              {!query.isLoading && !query.error && !query.data?.items.length && <EmptyState title="No dead letters found"><p>No failed executions match the selected filters.</p></EmptyState>}
              {!!query.data?.items.length && (
                <>
                  <DeadLetterTable items={query.data.items} />
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
