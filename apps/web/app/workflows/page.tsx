"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { ErrorMessage } from "../../components/error-message";
import { RequireAuth } from "../../features/auth/require-auth";
import { useCreateWorkflow, useWorkflows } from "../../features/workflows/hooks";
import { EmptyState } from "../../components/brand";

export default function WorkflowsPage() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useWorkflows();
  const createWorkflow = useCreateWorkflow();
  const { register, handleSubmit, reset } = useForm({ defaultValues: { name: "", description: "" } });

  async function onCreate(values: { name: string; description: string }) {
    const workflow = await createWorkflow.mutateAsync(values);
    reset();
    router.push(`/workflows/${workflow.id}`);
  }

  return (
    <RequireAuth>
      <main className="content stack">
        <header className="page-header"><div><span className="eyebrow">Build</span><h1>Workflows</h1><p className="muted">Design, test and publish reliable automation.</p></div></header>
        {error && <ErrorMessage error={error} onRetry={() => refetch()} />}
        {createWorkflow.error && <ErrorMessage error={createWorkflow.error} onRetry={() => createWorkflow.reset()} />}
        <form className="panel stack" onSubmit={handleSubmit(onCreate)}>
          <h2>Create workflow</h2>
          <div className="workflow-form-grid">
            <label>
              Name
              <input required minLength={2} {...register("name")} />
            </label>
            <label>
              Description
              <input {...register("description")} />
            </label>
          </div>
          <div>
            <button type="submit" disabled={createWorkflow.isPending}>
              {createWorkflow.isPending ? "Creating..." : "Create workflow"}
            </button>
          </div>
        </form>
        <section className="panel stack">
          {isLoading && <p className="muted">Loading...</p>}
          {!isLoading && !data?.length && <EmptyState branded title="Your first flow starts here"><p>Create a workflow, add a trigger and connect your first action.</p></EmptyState>}
          {data?.map((workflow) => (
            <div className="resource-row" key={workflow.id}>
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
