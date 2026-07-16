"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "../../../lib/api-client";
import { useRetryExecution } from "../hooks";

export function RetryExecutionDialog({
  open,
  executionId,
  deadLetterId,
  onClose
}: {
  open: boolean;
  executionId: string;
  deadLetterId?: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const router = useRouter();
  const retry = useRetryExecution(executionId, deadLetterId);

  if (!open) return null;

  async function submit() {
    try {
      const result = await retry.mutateAsync(reason.trim() || undefined);
      onClose();
      router.push(`/executions/${result.execution.id}`);
    } catch {
      // Rendered below.
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Retry execution">
        <h2>Retry execution</h2>
        <p className="muted">Se creará una nueva ejecución usando la misma versión y el mismo input.</p>
        <p className="muted">Los efectos externos que hayan quedado en estado ambiguo podrían repetirse. Flowmind no garantiza exactly-once.</p>
        <label className="stack">
          Motivo opcional
          <textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </label>
        {retry.error && <RetryError error={retry.error} />}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" onClick={onClose} disabled={retry.isPending}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={retry.isPending}>
            {retry.isPending ? "Submitting..." : "Create retry"}
          </button>
        </div>
      </section>
    </div>
  );
}

function RetryError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) {
    return <p role="alert">No tenés permisos para solicitar retry.</p>;
  }
  if (error instanceof ApiError && error.status === 409) {
    return <p role="alert">Ya existe un retry activo para esta ejecución.</p>;
  }
  if (error instanceof ApiError && error.status === 503 && isRecoverable(error.details)) {
    return <p role="alert">La nueva ejecución fue creada pero no se pudo encolar de inmediato. No reenvíes automáticamente; el reconciliador puede recuperarla.</p>;
  }
  return <p role="alert">No se pudo crear el retry.</p>;
}

function isRecoverable(value: unknown) {
  return Boolean(value && typeof value === "object" && "recoverable" in value && (value as { recoverable?: unknown }).recoverable);
}
