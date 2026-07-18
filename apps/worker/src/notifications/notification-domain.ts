import { createHash } from "node:crypto";
import type { InternalEventEnvelope } from "@automation/shared-types";

export const NOTIFICATION_EVENT_TYPES = ["APPROVAL_REQUESTED", "APPROVAL_APPROVED", "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "EXECUTION_COMPLETED", "EXECUTION_FAILED", "EVENT_TRIGGER_FAILED", "EVENT_CHAIN_DEPTH_EXCEEDED"] as const;
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];

export const TEMPLATE_BY_EVENT: Record<NotificationEventType, string> = {
  APPROVAL_REQUESTED: "approval.requested", APPROVAL_APPROVED: "approval.approved", APPROVAL_REJECTED: "approval.rejected", APPROVAL_EXPIRED: "approval.expired",
  EXECUTION_COMPLETED: "workflow.completed", EXECUTION_FAILED: "workflow.failed", EVENT_TRIGGER_FAILED: "event-trigger.failed", EVENT_CHAIN_DEPTH_EXCEEDED: "event-chain.depth-exceeded"
};

export function isNotificationEventType(value: unknown): value is NotificationEventType { return typeof value === "string" && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value); }
export function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
export function validEmail(value: string) { return value.length <= 254 && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(value); }
export function notificationIdempotency(ruleId: string, event: InternalEventEnvelope, recipient: string) {
  const data = event.data as unknown as Record<string, unknown>;
  const subject = String(data.approvalId ?? data.executionId ?? data.triggerId ?? event.subject.id ?? event.id);
  return createHash("sha256").update(`${ruleId}\0${event.type}\0${subject}\0${normalizeEmail(recipient)}`).digest("hex");
}

export function matchesNotificationFilters(event: InternalEventEnvelope, value: unknown) {
  const filters = record(value); const data = event.data as unknown as Record<string, unknown>;
  if (filters.workflowId && filters.workflowId !== data.workflowId) return false;
  if (filters.status && filters.status !== data.status && filters.status !== data.outcome) return false;
  if (filters.origin && filters.origin !== data.origin) return false;
  return true;
}

export function safePayload(event: InternalEventEnvelope, extras: Record<string, unknown> = {}) {
  const data = event.data as unknown as Record<string, unknown>;
  const allowed = ["approvalId", "executionId", "workflowId", "workflowVersionId", "stepKey", "outcome", "status", "origin", "requestedAt", "decidedAt", "expiresAt", "startedAt", "completedAt", "durationMs", "internalEventId", "triggerId", "eventType", "errorCode", "suppressedEventType", "rootEventId", "depth", "reason", "title", "description"];
  const output: Record<string, unknown> = {};
  for (const key of allowed) if (data[key] !== undefined) output[key] = safeScalar(data[key]);
  for (const [key, value] of Object.entries(extras)) output[key] = safeScalar(value);
  const encoded = JSON.stringify(output);
  if (Buffer.byteLength(encoded) > 16_384) throw new Error("notification_payload_too_large");
  return output;
}
function safeScalar(value: unknown) { if (value === null || typeof value === "boolean" || typeof value === "number") return value; return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
