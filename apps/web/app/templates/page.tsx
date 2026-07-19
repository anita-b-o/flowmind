"use client";
import Link from "next/link";
import { useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { RequireAuth } from "../../features/auth/require-auth";
import { useTemplates } from "../../features/templates/hooks";

export default function TemplatesPage() {
  const [status, setStatus] = useState("");
  const templates = useTemplates(status);
  return <RequireAuth><main className="content stack"><div><h1>Templates</h1><p className="muted">Reusable, versioned workflow snapshots scoped to this organization.</p></div>
    <label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option>DRAFT</option><option>PUBLISHED</option><option>ARCHIVED</option></select></label>
    {templates.error && <ErrorMessage error={templates.error} onRetry={() => templates.refetch()} />}
    <section className="panel stack">{templates.isLoading && <p>Loading…</p>}{templates.data?.items.map((template) => <div key={template.id}><Link href={`/templates/${template.id}`}><strong>{template.name}</strong></Link><p className="muted">{template.status} · {template.versionCount} version(s)</p></div>)}{!templates.isLoading && !templates.data?.items.length && <p className="muted">No templates found. Save a workflow version as a template to begin.</p>}</section>
  </main></RequireAuth>;
}
