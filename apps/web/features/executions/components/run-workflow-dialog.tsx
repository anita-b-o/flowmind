"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "../../../lib/api-client";
import { useCreateManualExecution } from "../hooks";

export function RunWorkflowDialog({
  open,
  workflowId,
  workflowName,
  onClose
}: {
  open: boolean;
  workflowId: string;
  workflowName: string;
  onClose: () => void;
}) {
  const [json, setJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [open]);
  const run = useCreateManualExecution(workflowId);
  const router = useRouter();

  if (!open) return null;

  async function submit() {
    setParseError(null);
    let payload: { trigger?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    if (json.trim()) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setParseError("El payload debe ser un objeto JSON.");
          return;
        }
        payload = parsed;
      } catch {
        setParseError("El JSON no es válido.");
        return;
      }
    } else {
      payload = { trigger: {}, metadata: {} };
    }
    try {
      const response = await run.mutateAsync({ payload, idempotencyKey });
      onClose();
      router.push(`/executions/${response.execution.id}`);
    } catch {
      // Rendered below.
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Run workflow">
        <h2>Run workflow</h2>
        <p className="muted">{workflowName} will run in real mode and may perform external effects.</p>
        <label className="stack">
          Input JSON
          <textarea
            value={json}
            placeholder={'{ "trigger": {}, "metadata": {} }'}
            onChange={(event) => setJson(event.target.value)}
            disabled={run.isPending}
          />
        </label>
        {parseError && <p role="alert">{parseError}</p>}
        {run.error && <RunError error={run.error} />}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" onClick={onClose} disabled={run.isPending}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={run.isPending}>
            {run.isPending ? "Sending..." : "Run"}
          </button>
        </div>
      </section>
    </div>
  );
}

function RunError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 409) return <p role="alert">This request conflicts with an existing execution request.</p>;
  if (error instanceof ApiError && error.status === 503) return <p role="alert">The execution was created but could not be enqueued immediately.</p>;
  return <p role="alert">The workflow could not be started.</p>;
}
