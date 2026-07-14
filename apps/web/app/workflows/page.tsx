"use client";

import Link from "next/link";
import { ErrorMessage } from "../../components/error-message";
import { RequireAuth } from "../../features/auth/require-auth";
import { useWorkflows } from "../../features/workflows/hooks";

export default function WorkflowsPage() {
  const { data, isLoading, error, refetch } = useWorkflows();

  return (
    <RequireAuth>
      <main className="content stack">
        <h1>Workflows</h1>
        {error && <ErrorMessage error={error} onRetry={() => refetch()} />}
        <section className="panel stack">
          {isLoading && <p className="muted">Loading...</p>}
          {!isLoading && !data?.length && <p className="muted">No workflows yet.</p>}
          {data?.map((workflow) => (
            <div key={workflow.id}>
              <Link href={`/workflows/${workflow.id}`}>
                <strong>{workflow.name}</strong>
              </Link>
              <p className="muted">{workflow.status}</p>
            </div>
          ))}
        </section>
      </main>
    </RequireAuth>
  );
}
