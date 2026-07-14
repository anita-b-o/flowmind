const toneByStatus: Record<string, string> = {
  PENDING: "#64748b",
  QUEUED: "#2563eb",
  RUNNING: "#7c3aed",
  COMPLETED: "#047857",
  FAILED: "#b91c1c",
  CANCELLED: "#475569",
  SKIPPED: "#a16207"
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 6,
        background: toneByStatus[status] ?? "#64748b",
        color: "#fff",
        fontSize: 12,
        fontWeight: 700,
        padding: "3px 8px"
      }}
    >
      {status}
    </span>
  );
}
