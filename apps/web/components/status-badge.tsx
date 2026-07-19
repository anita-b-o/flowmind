const success = new Set(["COMPLETED", "completed", "DLQ RESOLVED", "ACTIVE", "SENT", "APPROVED"]);
const danger = new Set(["FAILED", "failed", "DLQ ACTIVE", "REJECTED", "DEAD_LETTER"]);
const warning = new Set(["RETRYING", "waiting", "WAITING", "skipped", "SKIPPED", "AMBIGUOUS EFFECT", "EXPIRED"]);
const info = new Set(["QUEUED", "queued", "RUNNING", "running", "QUEUED RETRY", "REPLAY"]);

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-badge--${success.has(status) ? "success" : danger.has(status) ? "danger" : warning.has(status) ? "warning" : info.has(status) ? "info" : "neutral"}`}>
      <span className="status-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
