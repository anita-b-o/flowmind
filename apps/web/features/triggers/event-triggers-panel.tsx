"use client";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorMessage } from "../../components/error-message";
import { StatusBadge } from "../../components/status-badge";
import { useCreateEventTrigger, useDeleteEventTrigger, useDisableEventTrigger, useEnableEventTrigger, useEventTriggers, useUpdateEventTrigger } from "./hooks";
import type { EventTriggerInput, EventTriggerSummary, InternalEventType } from "./types";
import { useDataStores } from "../data-stores/hooks";
import { useWorkflows } from "../workflows/hooks";

const TYPES: InternalEventType[] = ["DATA_STORE_RECORD_CREATED", "DATA_STORE_RECORD_UPDATED", "DATA_STORE_RECORD_DELETED", "EXECUTION_COMPLETED", "EXECUTION_FAILED", "APPROVAL_APPROVED", "APPROVAL_REJECTED", "APPROVAL_EXPIRED"];

export function EventTriggersPanel({ workflowId, canManage }: { workflowId: string; canManage: boolean }) {
  const query = useEventTriggers(workflowId); const create = useCreateEventTrigger(workflowId); const update = useUpdateEventTrigger(workflowId);
  const enable = useEnableEventTrigger(workflowId); const disable = useDisableEventTrigger(workflowId); const remove = useDeleteEventTrigger(workflowId);
  const [creating, setCreating] = useState(false); const [deleteId, setDeleteId] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || enable.isPending || disable.isPending || remove.isPending;
  return <section className="panel stack">
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}><div><h2>Internal event triggers</h2><p className="muted">Start this workflow from durable FlowMind events.</p></div>{canManage && <button type="button" onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "Create"}</button>}</div>
    {query.error && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
    {create.error && <ErrorMessage error={create.error} onRetry={() => create.reset()} />}
    {creating && <EventForm busy={busy} onSave={async (input) => { await create.mutateAsync(input); setCreating(false); }} />}
    {!query.isLoading && !query.data?.length && <p className="muted">No internal event triggers configured.</p>}
    {query.data?.map((trigger) => <EventCard key={trigger.id} trigger={trigger} canManage={canManage} busy={busy} onSave={(input) => update.mutateAsync({ triggerId: trigger.id, input })} onToggle={() => trigger.enabled ? disable.mutateAsync(trigger.id) : enable.mutateAsync(trigger.id)} onDelete={() => setDeleteId(trigger.id)} />)}
    <ConfirmDialog open={Boolean(deleteId)} title="Delete event trigger" description="New matching events will not start this workflow. Historical events and executions remain available." confirmLabel={remove.isPending ? "Deleting..." : "Delete trigger"} onCancel={() => setDeleteId(null)} onConfirm={async () => { if (deleteId) await remove.mutateAsync(deleteId); setDeleteId(null); }} />
  </section>;
}

function EventCard({ trigger, canManage, busy, onSave, onToggle, onDelete }: { trigger: EventTriggerSummary; canManage: boolean; busy: boolean; onSave: (input: Partial<EventTriggerInput>) => Promise<unknown>; onToggle: () => Promise<unknown>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  return <div className="panel stack"><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{trigger.name}</strong> <StatusBadge status={trigger.enabled ? "ACTIVE" : "DISABLED"} /><p className="muted">{trigger.eventType}</p><p className="muted">{filterSummary(trigger.filters)}</p></div>{canManage && <div style={{ display: "flex", gap: 8 }}><button disabled={busy} onClick={onToggle}>{trigger.enabled ? "Disable" : "Enable"}</button><button disabled={busy} onClick={() => setEditing(!editing)}>Edit</button><button disabled={busy} onClick={onDelete}>Delete</button></div>}</div>
    <div style={{ display: "flex", gap: 12 }}>{trigger.lastExecutionId && <Link href={"/executions/" + trigger.lastExecutionId}>Last execution</Link>}<Link href={"/executions?workflowId=" + trigger.workflowId}>Execution history</Link></div><p className="muted">Last activation {trigger.lastReceivedAt ? new Date(trigger.lastReceivedAt).toLocaleString() : "never"}.</p>
    {editing && <EventForm initial={trigger} busy={busy} onSave={async (input) => { await onSave(input); setEditing(false); }} />}</div>;
}

function EventForm({ initial, busy, onSave }: { initial?: EventTriggerSummary; busy: boolean; onSave: (input: EventTriggerInput) => Promise<void> }) {
  const dataStores = useDataStores(); const workflows = useWorkflows();
  const [name, setName] = useState(initial?.name ?? "Internal event"); const [eventType, setEventType] = useState<InternalEventType>(initial?.eventType ?? "DATA_STORE_RECORD_CREATED");
  const [resourceId, setResourceId] = useState(initial?.filters.dataStoreId ?? initial?.filters.workflowId ?? ""); const [keyPrefix, setKeyPrefix] = useState(initial?.filters.keyPrefix ?? ""); const [origin, setOrigin] = useState(initial?.filters.origin ?? "");
  const dataStore = eventType.startsWith("DATA_STORE_"); const execution = eventType.startsWith("EXECUTION_");
  const filters = { ...(resourceId ? dataStore ? { dataStoreId: resourceId } : { workflowId: resourceId } : {}), ...(keyPrefix && dataStore ? { keyPrefix } : {}), ...(origin && execution ? { origin: origin as EventTriggerSummary["filters"]["origin"] } : {}) };
  return <div className="stack"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Event type<select value={eventType} onChange={(event) => { setEventType(event.target.value as InternalEventType); setResourceId(""); setKeyPrefix(""); setOrigin(""); }}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
    <label>{dataStore ? "Data Store (optional)" : "Source workflow (optional)"}<select value={resourceId} onChange={(event) => setResourceId(event.target.value)}><option value="">Any</option>{(dataStore ? dataStores.data ?? [] : workflows.data ?? []).map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>{dataStore && <label>Key prefix (optional)<input value={keyPrefix} onChange={(event) => setKeyPrefix(event.target.value)} /></label>}{execution && <label>Origin (optional)<select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">Any</option>{["manual","webhook","scheduled","event","subworkflow","retry"].map((value) => <option key={value}>{value}</option>)}</select></label>}
    <button disabled={busy || !name.trim()} onClick={() => onSave({ name, eventType, filters })}>{busy ? "Saving..." : "Save"}</button></div>;
}
function filterSummary(filters: EventTriggerSummary["filters"]) { const values = Object.entries(filters); return values.length ? values.map(([key, value]) => key + ": " + value).join(" · ") : "All matching events"; }
