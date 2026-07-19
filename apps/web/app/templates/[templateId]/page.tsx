"use client";
import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorMessage } from "../../../components/error-message";
import { RequireAuth } from "../../../features/auth/require-auth";
import { useAuth } from "../../../features/auth/use-auth";
import { useDataStores } from "../../../features/data-stores/hooks";
import { useConnections } from "../../../features/connections/hooks";
import { useInvocableWorkflows } from "../../../features/workflows/hooks";
import { useArchiveTemplate, useInstantiateTemplate, usePublishTemplate, useTemplate, useTemplatePreview, useTemplateVersion, useTemplateVersions } from "../../../features/templates/hooks";
import type { DependencyMapping, TemplateDependency } from "../../../features/templates/types";

export default function TemplateDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = use(params); const router = useRouter(); const detail = useTemplate(templateId); const versions = useTemplateVersions(templateId);
  const [versionId, setVersionId] = useState<string>(); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [mappings, setMappings] = useState<Record<string, DependencyMapping>>({});
  useEffect(() => { if (!versionId && versions.data?.[0]) setVersionId(versions.data[0].id); }, [versionId, versions.data]);
  const version = useTemplateVersion(templateId, versionId); const preview = useTemplatePreview(templateId, versionId); const instantiate = useInstantiateTemplate(templateId, versionId); const publish = usePublishTemplate(templateId); const archive = useArchiveTemplate(templateId);
  const { organizations, activeOrganizationId } = useAuth(); const role = organizations.find((entry) => entry.id === activeOrganizationId)?.role; const canEdit = ["owner", "admin", "editor"].includes(role ?? ""); const canAdmin = ["owner", "admin"].includes(role ?? "");
  const connections = useConnections(); const stores = useDataStores(); const workflows = useInvocableWorkflows();
  const dependencies = version.data?.dependencyManifestJson.dependencies ?? [];
  const candidates = useMemo(() => ({ CONNECTION: connections.data ?? [], DATA_STORE: stores.data ?? [], WORKFLOW: workflows.data ?? [] }), [connections.data, stores.data, workflows.data]);
  const mappingList = Object.values(mappings).filter((entry) => entry.targetResourceId);
  async function runPreview() { await preview.mutateAsync(mappingList); }
  async function create() { const workflow = await instantiate.mutateAsync({ name, description, mappings: mappingList }); router.push(`/workflows/${workflow.id}`); }
  return <RequireAuth><main className="content stack"><section className="panel stack"><h1>{detail.data?.name ?? "Template"}</h1><p>{detail.data?.description}</p><p className="muted">{detail.data?.status}</p>{detail.error && <ErrorMessage error={detail.error} onRetry={() => detail.refetch()} />}</section>
    <section className="panel stack"><h2>Versions</h2><select aria-label="Template version" value={versionId ?? ""} onChange={(event) => { setVersionId(event.target.value); setMappings({}); preview.reset(); }}>{versions.data?.map((item) => <option key={item.id} value={item.id}>v{item.versionNumber} · {item.publishedAt ? "PUBLISHED" : "DRAFT"}</option>)}</select>
      {canAdmin && version.data && !version.data.publishedAt && detail.data?.status !== "ARCHIVED" && <button onClick={() => publish.mutate(version.data!.id)}>Publish version</button>}{canAdmin && detail.data?.status !== "ARCHIVED" && <button onClick={() => archive.mutate()}>Archive template</button>}
      {version.data && <details><summary>Dependency manifest</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(version.data.dependencyManifestJson, null, 2)}</pre></details>}
    </section>
    <section className="panel stack"><h2>Create workflow from template</h2><p><strong>Copied:</strong> Graph v2, steps, portable configuration and safe declarative variables.</p><p><strong>Never copied:</strong> secrets, executions, history, approvals, runtime state or operational triggers.</p><p className="form-warning">Webhook, scheduled and event triggers must be configured explicitly after creation.</p>
      {dependencies.map((dependency) => <MappingField key={dependency.dependencyKey} dependency={dependency} items={candidates[dependency.kind]} value={mappings[dependency.dependencyKey]} onChange={(mapping) => setMappings((current) => ({ ...current, [dependency.dependencyKey]: mapping }))} />)}
      <label>Name<input value={name} minLength={2} required onChange={(event) => setName(event.target.value)} /></label><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <button disabled={!versionId || preview.isPending} onClick={runPreview}>Preview</button>{preview.error && <ErrorMessage error={preview.error} onRetry={runPreview} />}
      {preview.data && <div className="stack"><h3>{preview.data.canInstantiate ? "Ready to create" : "Blocked"}</h3>{preview.data.warnings.map((warning) => <p key={warning} className="form-warning">{warning}</p>)}{preview.data.blockers.map((blocker, index) => <p role="alert" key={`${blocker.code}-${index}`}>{blocker.message}</p>)}{preview.data.triggerHints.length > 0 && <details><summary>Trigger setup hints</summary><pre>{JSON.stringify(preview.data.triggerHints, null, 2)}</pre></details>}{canEdit && <button disabled={!preview.data.canInstantiate || name.trim().length < 2 || instantiate.isPending} onClick={create}>Create draft workflow</button>}</div>}
    </section>
  </main></RequireAuth>;
}
function MappingField({ dependency, items, value, onChange }: { dependency: TemplateDependency; items: Array<{ id: string; name: string; versions?: Array<{ id: string; versionNumber: number }> }>; value?: DependencyMapping; onChange: (value: DependencyMapping) => void }) { const selected = items.find((item) => item.id === value?.targetResourceId); return <div className="stack"><label>{dependency.kind} for {dependency.stepKey} <select value={value?.targetResourceId ?? ""} onChange={(event) => onChange({ dependencyKey: dependency.dependencyKey, targetResourceId: event.target.value })}><option value="">Select mapping…</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{dependency.kind === "WORKFLOW" && dependency.expectedType === "PINNED_VERSION" && value?.targetResourceId && <label>Published target version <select value={value.targetWorkflowVersionId ?? ""} onChange={(event) => onChange({ ...value, targetWorkflowVersionId: event.target.value })}><option value="">Select version…</option>{selected?.versions?.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}</select></label>}<span className="muted">{dependency.message}</span></div>; }
