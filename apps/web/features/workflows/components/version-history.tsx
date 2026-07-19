"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorMessage } from "../../../components/error-message";
import { canCreateTemplate, canRestoreWorkflowVersion, type OrganizationRole } from "../../auth/rbac";
import { useRestoreWorkflowVersion, useWorkflowRestorePreview, useWorkflowVersionDiff, useWorkflowVersions } from "../hooks";
import { useCreateTemplate } from "../../templates/hooks";

export function VersionHistory({ workflowId, role, onRefresh }: { workflowId: string; role: OrganizationRole; onRefresh: () => void }) {
  const router = useRouter();
  const history = useWorkflowVersions(workflowId);
  const versions = history.data?.items ?? [];
  const [fromId, setFromId] = useState<string>();
  const [toId, setToId] = useState<string>();
  const [severity, setSeverity] = useState("ALL");
  const [restoreId, setRestoreId] = useState<string>();
  const [templateVersionId, setTemplateVersionId] = useState<string>();
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  useEffect(() => {
    if (!fromId && versions[1]) setFromId(versions[1].id);
    if (!toId && versions[0]) setToId(versions[0].id);
  }, [fromId, toId, versions]);
  const diff = useWorkflowVersionDiff(workflowId, fromId, toId);
  const preview = useWorkflowRestorePreview(workflowId, restoreId);
  const restore = useRestoreWorkflowVersion(workflowId);
  const createTemplate = useCreateTemplate();
  const findings = (diff.data?.findings ?? []).filter((item) => severity === "ALL" || item.severity === severity);

  async function confirmRestore() {
    if (!restoreId) return;
    const created = await restore.mutateAsync(restoreId);
    setRestoreId(undefined);
    onRefresh();
    router.push(`/workflows/${workflowId}?version=${created.id}`);
  }
  async function saveTemplate() {
    if (!templateVersionId) return;
    await createTemplate.mutateAsync({ name: templateName, description: templateDescription, workflowId, workflowVersionId: templateVersionId });
    setTemplateVersionId(undefined); setTemplateName(""); setTemplateDescription("");
  }

  return <section className="panel stack" aria-label="Version history">
    <div><h2>Version History</h2><p className="muted">Published snapshots are immutable. Restore creates a new draft.</p></div>
    {history.error && <ErrorMessage error={history.error} onRetry={() => history.refetch()} />}
    <div className="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>Created</th><th>Published</th><th>Creator</th><th>Lineage</th><th /></tr></thead><tbody>
      {versions.map((version) => <tr key={version.id}><td><a href={`/workflows/${workflowId}?version=${version.id}`}>v{version.versionNumber}</a>{version.isActive ? " · Active" : ""}</td><td>{version.status}</td><td>{formatDate(version.createdAt)}</td><td>{version.publishedAt ? formatDate(version.publishedAt) : "-"}</td><td>{version.createdBy?.name ?? version.createdBy?.email ?? "-"}</td><td>{version.restoredFromVersion ? `Restored from v${version.restoredFromVersion.versionNumber}` : "-"}</td><td><div style={{display:"flex", gap:8}}>{canRestoreWorkflowVersion(role) && <button type="button" onClick={() => setRestoreId(version.id)}>Restore</button>}{canCreateTemplate(role) && <button type="button" onClick={() => setTemplateVersionId(version.id)}>Save as template</button>}</div></td></tr>)}
    </tbody></table></div>
    {versions.length >= 2 && <div className="stack">
      <h3>Compare versions</h3>
      <div style={{display:"flex", gap:12, flexWrap:"wrap"}}><label>From <select value={fromId} onChange={(event) => setFromId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}</select></label><button type="button" onClick={() => { setFromId(toId); setToId(fromId); }}>⇄</button><label>To <select value={toId} onChange={(event) => setToId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}</select></label></div>
      {diff.error && <ErrorMessage error={diff.error} onRetry={() => diff.refetch()} />}
      {diff.data && <><p><strong>{diff.data.summary.maxSeverity}</strong> · {diff.data.summary.totalChanges} semantic changes · heuristic analysis</p>{!diff.data.triggerHistoryAvailable && <p className="form-warning">Materialized trigger history is unavailable for one or both legacy versions.</p>}
        <label>Severity <select value={severity} onChange={(event) => setSeverity(event.target.value)}><option>ALL</option><option>BREAKING</option><option>WARNING</option><option>SAFE</option></select></label>
        {findings.map((finding, index) => <p key={`${finding.code}-${index}`}><strong>{finding.severity}</strong> · {finding.message}</p>)}
        {Object.entries(diff.data.groups).map(([group, changes]) => changes.length ? <details key={group}><summary>{label(group)} ({changes.length})</summary><div className="stack">{changes.map((change, index) => <Change key={index} value={change} />)}</div></details> : null)}
      </>}
    </div>}
    {preview.data && restoreId && <div className={preview.data.publishable ? "muted" : "form-warning"}>Restore is possible. The resulting draft is {preview.data.publishable ? "currently publishable" : "not publishable until missing or invalid dependencies are corrected"}.</div>}
    {restore.error && <ErrorMessage error={restore.error} onRetry={() => restore.reset()} />}
    <ConfirmDialog open={Boolean(restoreId)} title="Restore workflow version" description="Restoring creates a new draft version. Existing executions and historical versions are not changed." confirmLabel={restore.isPending ? "Restoring..." : "Restore version"} onConfirm={confirmRestore} onCancel={() => setRestoreId(undefined)} />
    {templateVersionId && <div className="panel stack" role="dialog" aria-label="Save as template"><h3>Save as template</h3><p>Only the declarative workflow is copied. Secrets, history, executions, runtime state and operational triggers are never copied.</p><label>Name<input required minLength={2} value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label><label>Description<input value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} /></label>{createTemplate.error && <ErrorMessage error={createTemplate.error} onRetry={() => createTemplate.reset()} />}<div><button disabled={templateName.trim().length < 2 || createTemplate.isPending} onClick={saveTemplate}>Save template</button> <button onClick={() => setTemplateVersionId(undefined)}>Cancel</button></div></div>}
  </section>;
}

function Change({ value }: { value: unknown }) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : { value };
  if (row.sensitive) return <p><code>{String(row.fieldPath ?? "config")}</code>: Sensitive value changed</p>;
  return <pre style={{whiteSpace:"pre-wrap", overflowWrap:"anywhere"}}>{JSON.stringify(value, null, 2)}</pre>;
}
function label(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
