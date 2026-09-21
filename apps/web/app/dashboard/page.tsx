"use client";

import Link from "next/link";
import { BrandHero } from "../../components/brand";
import { ErrorMessage } from "../../components/error-message";
import { LoadingState } from "../../components/loading-state";
import { useAuth } from "../../features/auth/use-auth";
import { useExecutions } from "../../features/executions/hooks";
import { useWorkflows } from "../../features/workflows/hooks";

export default function DashboardPage() {
  const { user } = useAuth();
  const workflows = useWorkflows();
  const executions = useExecutions({ limit: 20 });

  return <main className="content stack">
    <BrandHero eyebrow="Workspace overview" title={`Welcome${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.`}><p>See what is moving, what needs attention and where to build next.</p><div className="brand-actions"><Link href="/workflows">Open workflows</Link><Link className="secondary" href="/templates">Explore templates</Link></div></BrandHero>
    <div className="grid">
      <div className="panel stat-card"><strong>Workflows</strong>{workflows.isLoading ? <LoadingState label="Loading workflows..." /> : workflows.error ? <ErrorMessage error={workflows.error} onRetry={() => workflows.refetch()} /> : <><p className="stat-value">{workflows.data?.length ?? 0}</p><p className="muted">Workflows in this workspace.</p></>}</div>
      <div className="panel stat-card"><strong>Recent executions</strong>{executions.isLoading ? <LoadingState label="Loading executions..." /> : executions.error ? <ErrorMessage error={executions.error} onRetry={() => executions.refetch()} /> : <><p className="stat-value">{executions.data?.items.length ?? 0}{executions.data?.hasMore ? "+" : ""}</p><p className="muted">{executions.data?.items.length ? "Latest runs. Open execution history for details." : "Runs appear after a workflow executes."}</p></>}</div>
      <div className="panel stat-card"><strong>LLM cost</strong><p className="stat-value">—</p><p className="muted">AI step costs appear in execution details after those steps run.</p></div>
    </div>
  </main>;
}
