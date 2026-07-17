"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorMessage } from "../../components/error-message";
import { StatusBadge } from "../../components/status-badge";
import type { OneTimeSecret } from "../../components/one-time-secret-panel";
import {
  useCreateWebhookTrigger,
  useDeleteWebhookTrigger,
  useDisableWebhookTrigger,
  useEnableWebhookTrigger,
  useRotateWebhookTrigger,
  useTriggers,
  useUpdateWebhookTrigger
} from "./hooks";
import type { TriggerSummary, UpdateWebhookTriggerInput } from "./types";

export function WebhookTriggersPanel({ workflowId, canManage, onSecret }: { workflowId: string; canManage: boolean; onSecret: (secret: OneTimeSecret) => void }) {
  const triggers = useTriggers(workflowId);
  const createTrigger = useCreateWebhookTrigger(workflowId);
  const rotateTrigger = useRotateWebhookTrigger(workflowId);
  const enableTrigger = useEnableWebhookTrigger(workflowId);
  const disableTrigger = useDisableWebhookTrigger(workflowId);
  const deleteTrigger = useDeleteWebhookTrigger(workflowId);
  const updateTrigger = useUpdateWebhookTrigger(workflowId);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const busy = createTrigger.isPending || rotateTrigger.isPending || enableTrigger.isPending || disableTrigger.isPending || deleteTrigger.isPending || updateTrigger.isPending;

  async function onCreate() {
    const result = await createTrigger.mutateAsync(undefined);
    onSecret({ token: result.token, webhookUrl: result.webhookUrl, signatureSecret: result.signatureSecret });
  }

  async function onRotate() {
    if (!rotateId) return;
    const result = await rotateTrigger.mutateAsync(rotateId);
    onSecret({ token: result.token, webhookUrl: result.webhookUrl, signatureSecret: result.signatureSecret });
    setRotateId(null);
  }

  async function onDelete() {
    if (!deleteId) return;
    await deleteTrigger.mutateAsync(deleteId);
    setDeleteId(null);
  }

  return (
    <section className="panel stack">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2>Webhook trigger</h2>
          <p className="muted">Tokens are shown only when created or rotated. Rotating invalidates the previous URL immediately.</p>
        </div>
        {canManage && (
          <button type="button" onClick={onCreate} disabled={busy}>
            {createTrigger.isPending ? "Creating..." : "Create"}
          </button>
        )}
      </div>
      {triggers.error && <ErrorMessage error={triggers.error} onRetry={() => triggers.refetch()} />}
      {createTrigger.error && <ErrorMessage error={createTrigger.error} onRetry={() => createTrigger.reset()} />}
      {updateTrigger.error && <ErrorMessage error={updateTrigger.error} onRetry={() => updateTrigger.reset()} />}
      {triggers.isLoading && <p className="muted">Loading triggers...</p>}
      {!triggers.isLoading && !triggers.data?.length && <p className="muted">No webhook trigger has been created for this workflow.</p>}
      {triggers.data?.map((trigger) => (
        <WebhookTriggerCard
          key={trigger.id}
          trigger={trigger}
          canManage={canManage}
          busy={busy}
          onEnable={() => enableTrigger.mutateAsync(trigger.id)}
          onDisable={() => disableTrigger.mutateAsync(trigger.id)}
          onRotate={() => setRotateId(trigger.id)}
          onDelete={() => setDeleteId(trigger.id)}
          onUpdate={(input) => updateTrigger.mutateAsync({ triggerId: trigger.id, input }).then((result) => {
            if ("signatureSecret" in result && result.signatureSecret) {
              onSecret({ token: "", webhookUrl: result.maskedWebhookUrl, signatureSecret: result.signatureSecret });
            }
          })}
        />
      ))}
      <ConfirmDialog
        open={Boolean(rotateId)}
        title="Rotate webhook token"
        description="The current token and URL will stop working immediately. The new token will be shown once."
        confirmLabel={rotateTrigger.isPending ? "Rotating..." : "Rotate token"}
        onCancel={() => setRotateId(null)}
        onConfirm={onRotate}
      />
      <ConfirmDialog
        open={Boolean(deleteId)}
        title="Delete webhook trigger"
        description="New webhook calls will be blocked. Historical executions and audit records will be preserved."
        confirmLabel={deleteTrigger.isPending ? "Deleting..." : "Delete trigger"}
        onCancel={() => setDeleteId(null)}
        onConfirm={onDelete}
      />
    </section>
  );
}

function WebhookTriggerCard({
  trigger,
  canManage,
  busy,
  onEnable,
  onDisable,
  onRotate,
  onDelete,
  onUpdate
}: {
  trigger: TriggerSummary;
  canManage: boolean;
  busy: boolean;
  onEnable: () => Promise<unknown>;
  onDisable: () => Promise<unknown>;
  onRotate: () => void;
  onDelete: () => void;
  onUpdate: (input: UpdateWebhookTriggerInput) => Promise<unknown>;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState(() => ({
    name: trigger.config.name,
    idempotencyHeader: trigger.config.idempotencyHeader,
    maxBytes: trigger.config.payloadLimits.maxBytes,
    maxDepth: trigger.config.payloadLimits.maxDepth,
    maxKeys: trigger.config.payloadLimits.maxKeys,
    maxArrayLength: trigger.config.payloadLimits.maxArrayLength,
    maxStringLength: trigger.config.payloadLimits.maxStringLength,
    requireBody: trigger.config.payloadLimits.requireBody,
    signatureEnabled: trigger.config.signature.enabled,
    signatureHeader: trigger.config.signature.signatureHeader,
    timestampHeader: trigger.config.signature.timestampHeader,
    nonceHeader: trigger.config.signature.nonceHeader,
    toleranceSeconds: trigger.config.signature.toleranceSeconds
  }));
  const methodLabel = useMemo(() => trigger.method || trigger.httpMethod || "POST", [trigger.httpMethod, trigger.method]);

  async function copyMasked() {
    await navigator.clipboard.writeText(trigger.maskedWebhookUrl);
  }

  function save() {
    return onUpdate({
      name: form.name,
      idempotencyHeader: form.idempotencyHeader,
      payloadLimits: {
        maxBytes: Number(form.maxBytes),
        maxDepth: Number(form.maxDepth),
        maxKeys: Number(form.maxKeys),
        maxArrayLength: Number(form.maxArrayLength),
        maxStringLength: Number(form.maxStringLength),
        requireBody: form.requireBody
      },
      signature: {
        enabled: form.signatureEnabled,
        signatureHeader: form.signatureHeader,
        timestampHeader: form.timestampHeader,
        nonceHeader: form.nonceHeader,
        toleranceSeconds: Number(form.toleranceSeconds)
      }
    });
  }

  return (
    <div className="panel stack">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div className="stack" style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{trigger.config.name || "Webhook"}</strong>
            <StatusBadge status={trigger.enabled ? "ACTIVE" : "DISABLED"} />
            <span className="muted">{methodLabel}</span>
          </div>
          <label className="stack">
            Public URL
            <input readOnly value={trigger.maskedWebhookUrl} aria-label="Masked webhook URL" />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={copyMasked}>
              Copy preview
            </button>
            {trigger.lastExecutionId && <Link href={`/executions/${trigger.lastExecutionId}`}>Last execution</Link>}
            <Link href={`/executions?workflowId=${trigger.workflowId}`}>Execution history</Link>
          </div>
          <p className="muted">Created {formatDate(trigger.createdAt)}. Rotated {trigger.rotatedAt ? formatDate(trigger.rotatedAt) : "never"}.</p>
          <p className="muted">Last received {trigger.lastReceivedAt ? formatDate(trigger.lastReceivedAt) : "never"}.</p>
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
            <button type="button" onClick={onRotate} disabled={busy}>
              Rotate
            </button>
            <button type="button" onClick={() => setAdvancedOpen((value) => !value)}>
              {advancedOpen ? "Hide settings" : "Settings"}
            </button>
            <button type="button" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>
      {advancedOpen && (
        <div className="stack">
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <label className="stack">
              Name
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="stack">
              Idempotency header
              <input value={form.idempotencyHeader} onChange={(event) => setForm({ ...form, idempotencyHeader: event.target.value })} />
            </label>
            <NumberInput label="Max bytes" value={form.maxBytes} onChange={(maxBytes) => setForm({ ...form, maxBytes })} />
            <NumberInput label="Max depth" value={form.maxDepth} onChange={(maxDepth) => setForm({ ...form, maxDepth })} />
            <NumberInput label="Max keys" value={form.maxKeys} onChange={(maxKeys) => setForm({ ...form, maxKeys })} />
            <NumberInput label="Max array length" value={form.maxArrayLength} onChange={(maxArrayLength) => setForm({ ...form, maxArrayLength })} />
            <NumberInput label="Max string length" value={form.maxStringLength} onChange={(maxStringLength) => setForm({ ...form, maxStringLength })} />
          </div>
          <label>
            <input type="checkbox" checked={form.requireBody} onChange={(event) => setForm({ ...form, requireBody: event.target.checked })} /> Require non-empty body
          </label>
          <label>
            <input type="checkbox" checked={form.signatureEnabled} onChange={(event) => setForm({ ...form, signatureEnabled: event.target.checked })} /> Require HMAC signature
          </label>
          {form.signatureEnabled && (
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <label className="stack">
                Signature header
                <input value={form.signatureHeader} onChange={(event) => setForm({ ...form, signatureHeader: event.target.value })} />
              </label>
              <label className="stack">
                Timestamp header
                <input value={form.timestampHeader} onChange={(event) => setForm({ ...form, timestampHeader: event.target.value })} />
              </label>
              <label className="stack">
                Nonce header
                <input value={form.nonceHeader} onChange={(event) => setForm({ ...form, nonceHeader: event.target.value })} />
              </label>
              <NumberInput label="Tolerance seconds" value={form.toleranceSeconds} onChange={(toleranceSeconds) => setForm({ ...form, toleranceSeconds })} />
            </div>
          )}
          <div>
            <button type="button" onClick={save} disabled={busy}>
              Save settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="stack">
      {label}
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
