"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ExecutionReplayMode } from "../types";
import { useReplayExecution, useReplayPreview } from "../hooks";

export function ReplayExecutionDialog({ open, executionId, failed, onClose }: { open: boolean; executionId: string; failed: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<ExecutionReplayMode>(failed ? "RETRY_FROM_FAILURE" : "FULL_REPLAY");
  const [reason, setReason] = useState(""); const [confirmed, setConfirmed] = useState(false); const router = useRouter();
  const preview = useReplayPreview(executionId, mode, open); const replay = useReplayExecution(executionId);
  if (!open) return null;
  const data = preview.data; const needsConfirmation = mode === "FULL_REPLAY" && Boolean(data?.sideEffects.length);
  return <div className="modal-backdrop" role="presentation"><section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Replay execution">
    <h2>Replay execution</h2>
    <label className="stack">Mode<select value={mode} onChange={(event) => { setMode(event.target.value as ExecutionReplayMode); setConfirmed(false); }}><option value="FULL_REPLAY">Replay full workflow</option>{failed && <option value="RETRY_FROM_FAILURE">Retry from failure</option>}</select></label>
    {preview.isLoading && <p className="muted">Checking durable checkpoint…</p>}
    {data?.startingPoint && <p>Starting at <strong>{data.startingPoint.stepKey}</strong> · <code>{data.startingPoint.executionPath}</code></p>}
    {data && <p>{data.reusedSteps.length} reused · {data.reexecutedSteps.length} executed</p>}
    {data?.warnings.map((warning) => <p role="alert" key={warning}>{warning}</p>)}
    {data && !data.possible && <p role="alert">Replay unavailable: {data.blockedReasons.join(", ")}{data.missingCheckpointData.length ? ` · Missing ${data.missingCheckpointData.join(", ")}` : ""}</p>}
    {needsConfirmation && <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I understand that this replay may repeat side effects.</label>}
    <label className="stack">Optional reason<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
    {replay.error && <p role="alert">Replay could not be created.</p>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}><button type="button" onClick={onClose}>Cancel</button><button type="button" disabled={!data?.possible || replay.isPending || (needsConfirmation && !confirmed)} onClick={async () => { const result = await replay.mutateAsync({ mode, reason: reason.trim() || undefined }); onClose(); router.push(`/executions/${result.execution.id}`); }}>{replay.isPending ? "Creating…" : "Create replay"}</button></div>
  </section></div>;
}
