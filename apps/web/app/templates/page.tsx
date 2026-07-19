"use client";
import Link from "next/link";
import { useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { RequireAuth } from "../../features/auth/require-auth";
import { useTemplates } from "../../features/templates/hooks";
import { EmptyState } from "../../components/brand";

export default function TemplatesPage() {
  const [status, setStatus] = useState("");
  const templates = useTemplates(status);
  return <RequireAuth><main className="content stack"><header className="template-header"><div><span className="eyebrow">Discover</span><h1>Templates</h1><p>Reusable starting points for the workflows your team runs most.</p></div><img src="/brand/koi-line.webp" alt="" aria-hidden="true" /></header>
    <label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option>DRAFT</option><option>PUBLISHED</option><option>ARCHIVED</option></select></label>
    {templates.error && <ErrorMessage error={templates.error} onRetry={() => templates.refetch()} />}
    <section className="panel stack">{templates.isLoading && <p>Loading…</p>}{templates.data?.items.map((template) => <div className="resource-row" key={template.id}><Link href={`/templates/${template.id}`}><strong>{template.name}</strong></Link><p className="muted">{template.status} · {template.versionCount} version(s)</p></div>)}{!templates.isLoading && !templates.data?.items.length && <EmptyState branded title="Create a reusable starting point"><p>Save a workflow version as a template to share proven patterns across your organization.</p></EmptyState>}</section>
  </main></RequireAuth>;
}
