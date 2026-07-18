import { Injectable } from "@nestjs/common";

@Injectable()
export class NotificationTemplates {
  render(templateKey: string, payload: Record<string, unknown>) {
    const title = text(payload.title ?? payload.workflowName ?? "FlowMind notification", 200);
    const status = text(payload.status ?? payload.outcome ?? payload.reason ?? "", 80);
    const description = text(payload.description ?? "", 2_000);
    const link = internalLink(payload.link);
    const subject = subjectFor(templateKey, title, status);
    const lines = [subject, description, status ? `Status: ${status}` : "", link ? `Open in FlowMind: ${link}` : ""].filter(Boolean);
    const body = lines.join("\n\n");
    return { subject, text: body, html: `<div><h1>${escapeHtml(subject)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}${status ? `<p><strong>Status:</strong> ${escapeHtml(status)}</p>` : ""}${link ? `<p><a href="${escapeHtml(link)}">Open in FlowMind</a></p>` : ""}</div>` };
  }
}

function subjectFor(key: string, title: string, status: string) {
  const labels: Record<string, string> = { "approval.requested": "Approval requested", "approval.approved": "Approval approved", "approval.rejected": "Approval rejected", "approval.expired": "Approval expired", "workflow.completed": "Workflow completed", "workflow.failed": "Workflow failed", "event-trigger.failed": "Event trigger failed", "event-chain.depth-exceeded": "Event chain limit exceeded" };
  const label = labels[key]; if (!label) throw Object.assign(new Error("Unknown notification template"), { code: "TEMPLATE_NOT_FOUND", permanent: true });
  return `${label}: ${title}${status && !key.startsWith("approval.") ? ` (${status})` : ""}`.replace(/[\r\n]/g, " ").slice(0, 300);
}
function text(value: unknown, max: number) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").trim().slice(0, max); }
function internalLink(value: unknown) { const raw = String(value ?? ""); try { const url = new URL(raw); const expected = new URL(process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN?.split(",")[0] ?? "http://localhost:3000"); return url.origin === expected.origin && /^\/(approvals|executions)\/[A-Za-z0-9-]+$/.test(url.pathname) ? url.toString() : ""; } catch { return ""; } }
function escapeHtml(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
