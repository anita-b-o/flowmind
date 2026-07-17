"use client";

import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorMessage } from "../../components/error-message";
import { StatusBadge } from "../../components/status-badge";
import {
  useCreateScheduledTrigger,
  useDeleteScheduledTrigger,
  useDisableScheduledTrigger,
  useEnableScheduledTrigger,
  usePauseScheduledTrigger,
  usePreviewScheduledTrigger,
  useResumeScheduledTrigger,
  useScheduledTriggers,
  useUpdateScheduledTrigger
} from "./hooks";
import type { ScheduledTriggerInput, ScheduledTriggerSummary } from "./types";

const CRON_EXAMPLES = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Mon-Fri 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Sunday", cron: "0 9 * * 0" },
  { label: "First day monthly", cron: "0 9 1 * *" }
];

const TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Madrid", "Asia/Tokyo"];

export function ScheduledTriggersPanel({ workflowId, canManage }: { workflowId: string; canManage: boolean }) {
  const triggers = useScheduledTriggers(workflowId);
  const createTrigger = useCreateScheduledTrigger(workflowId);
  const updateTrigger = useUpdateScheduledTrigger(workflowId);
  const enableTrigger = useEnableScheduledTrigger(workflowId);
  const disableTrigger = useDisableScheduledTrigger(workflowId);
  const pauseTrigger = usePauseScheduledTrigger(workflowId);
  const resumeTrigger = useResumeScheduledTrigger(workflowId);
  const deleteTrigger = useDeleteScheduledTrigger(workflowId);
  const previewTrigger = usePreviewScheduledTrigger(workflowId);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduledTriggerInput>({ cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", enabled: true, paused: false, executionPolicy: "skip_if_running" });
  const busy =
    createTrigger.isPending ||
    updateTrigger.isPending ||
    enableTrigger.isPending ||
    disableTrigger.isPending ||
    pauseTrigger.isPending ||
    resumeTrigger.isPending ||
    deleteTrigger.isPending ||
    previewTrigger.isPending;

  async function save() {
    if (editingId) {
      await updateTrigger.mutateAsync({ triggerId: editingId, input: form });
      setEditingId(null);
    } else {
      await createTrigger.mutateAsync(form);
    }
  }

  async function preview() {
    await previewTrigger.mutateAsync(form);
  }

  async function onDelete() {
    if (!deleteId) return;
    await deleteTrigger.mutateAsync(deleteId);
    setDeleteId(null);
  }

  function edit(trigger: ScheduledTriggerSummary) {
    setEditingId(trigger.id);
    setForm({
      cron: trigger.cron,
      timezone: trigger.timezone,
      enabled: trigger.enabled,
      paused: trigger.paused,
      executionPolicy: trigger.executionPolicy,
      metadata: trigger.metadata
    });
  }

  return (
    <section className="panel stack">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2>Scheduled trigger</h2>
          <p className="muted">Run this workflow automatically from a cron schedule and timezone.</p>
        </div>
      </div>
      {triggers.error && <ErrorMessage error={triggers.error} onRetry={() => triggers.refetch()} />}
      {createTrigger.error && <ErrorMessage error={createTrigger.error} onRetry={() => createTrigger.reset()} />}
      {updateTrigger.error && <ErrorMessage error={updateTrigger.error} onRetry={() => updateTrigger.reset()} />}
      {previewTrigger.error && <ErrorMessage error={previewTrigger.error} onRetry={() => previewTrigger.reset()} />}
      {canManage && (
        <div className="stack">
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <label className="stack">
              Cron
              <input value={form.cron} onChange={(event) => setForm({ ...form, cron: event.target.value })} aria-label="Scheduled trigger cron" />
            </label>
            <label className="stack">
              Timezone
              <input list="scheduled-timezones" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} aria-label="Scheduled trigger timezone" />
              <datalist id="scheduled-timezones">
                {TIMEZONES.map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CRON_EXAMPLES.map((example) => (
              <button key={example.label} type="button" onClick={() => setForm({ ...form, cron: example.cron })} disabled={busy}>
                {example.label}
              </button>
            ))}
          </div>
          <label>
            <input type="checkbox" checked={form.enabled ?? true} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> Enabled
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={preview} disabled={busy}>
              {previewTrigger.isPending ? "Previewing..." : "Preview next runs"}
            </button>
            <button type="button" onClick={save} disabled={busy}>
              {editingId ? "Save schedule" : "Create schedule"}
            </button>
            {editingId && (
              <button type="button" onClick={() => setEditingId(null)} disabled={busy}>
                Cancel edit
              </button>
            )}
          </div>
          {previewTrigger.data && (
            <div className="stack">
              <strong>Next runs</strong>
              {previewTrigger.data.nextRuns.map((run) => (
                <span key={run} className="muted">
                  {formatDate(run)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {triggers.isLoading && <p className="muted">Loading scheduled triggers...</p>}
      {!triggers.isLoading && !triggers.data?.length && <p className="muted">No scheduled trigger has been created for this workflow.</p>}
      {triggers.data?.map((trigger) => (
        <ScheduledTriggerCard
          key={trigger.id}
          trigger={trigger}
          canManage={canManage}
          busy={busy}
          onEdit={() => edit(trigger)}
          onEnable={() => enableTrigger.mutateAsync(trigger.id)}
          onDisable={() => disableTrigger.mutateAsync(trigger.id)}
          onPause={() => pauseTrigger.mutateAsync(trigger.id)}
          onResume={() => resumeTrigger.mutateAsync(trigger.id)}
          onDelete={() => setDeleteId(trigger.id)}
        />
      ))}
      <ConfirmDialog
        open={Boolean(deleteId)}
        title="Delete scheduled trigger"
        description="Future scheduled runs will stop. Historical executions and audit records will be preserved."
        confirmLabel={deleteTrigger.isPending ? "Deleting..." : "Delete trigger"}
        onCancel={() => setDeleteId(null)}
        onConfirm={onDelete}
      />
    </section>
  );
}

function ScheduledTriggerCard({
  trigger,
  canManage,
  busy,
  onEdit,
  onEnable,
  onDisable,
  onPause,
  onResume,
  onDelete
}: {
  trigger: ScheduledTriggerSummary;
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onEnable: () => Promise<unknown>;
  onDisable: () => Promise<unknown>;
  onPause: () => Promise<unknown>;
  onResume: () => Promise<unknown>;
  onDelete: () => void;
}) {
  return (
    <div className="panel stack">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div className="stack" style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{trigger.cron}</strong>
            <StatusBadge status={trigger.enabled && !trigger.paused ? "ACTIVE" : trigger.paused ? "PAUSED" : "DISABLED"} />
            <span className="muted">{trigger.timezone}</span>
          </div>
          <p className="muted">Next run {trigger.nextRunAt ? formatDate(trigger.nextRunAt) : "not scheduled"}.</p>
          <p className="muted">Last run {trigger.lastRunAt ? formatDate(trigger.lastRunAt) : "never"}.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {trigger.lastExecutionId && <Link href={`/executions/${trigger.lastExecutionId}`}>Last execution</Link>}
            <Link href={`/executions?workflowId=${trigger.workflowId}`}>Execution history</Link>
          </div>
        </div>
        {canManage && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {trigger.enabled ? (
              <button type="button" onClick={onDisable} disabled={busy}>
                Disable
              </button>
            ) : (
              <button type="button" onClick={onEnable} disabled={busy}>
                Enable
              </button>
            )}
            {trigger.paused ? (
              <button type="button" onClick={onResume} disabled={busy}>
                Resume
              </button>
            ) : (
              <button type="button" onClick={onPause} disabled={busy}>
                Pause
              </button>
            )}
            <button type="button" onClick={onEdit} disabled={busy}>
              Edit
            </button>
            <button type="button" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
