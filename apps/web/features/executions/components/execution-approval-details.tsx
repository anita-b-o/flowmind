import Link from "next/link";
import { StatusBadge } from "../../../components/status-badge";

export function ExecutionApprovalDetails({ waitReason, approvals }: { waitReason?: string | null; approvals: Array<{ id: string; status: string; title: string; requestedAt: string; expiresAt: string | null; decidedAt: string | null; stepKey: string }> }) {
  if (waitReason !== "approval" && approvals.length === 0) return null;
  return <section className="panel stack"><h2>Approvals</h2>{waitReason === "approval" && <p><strong>Waiting for approval</strong></p>}{approvals.map((approval) => <p key={approval.id}><StatusBadge status={approval.status} /> <Link href={`/approvals/${approval.id}`}>{approval.title}</Link> · {approval.stepKey} · requested {formatDate(approval.requestedAt)}{approval.expiresAt ? ` · expires ${formatDate(approval.expiresAt)}` : ""}{approval.decidedAt ? ` · decided ${formatDate(approval.decidedAt)}` : ""}</p>)}</section>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
