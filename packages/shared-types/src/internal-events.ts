export const INTERNAL_EVENT_TYPES = [
  "DATA_STORE_RECORD_CREATED",
  "DATA_STORE_RECORD_UPDATED",
  "DATA_STORE_RECORD_DELETED",
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "APPROVAL_APPROVED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED"
] as const;

export type InternalEventType = (typeof INTERNAL_EVENT_TYPES)[number];
export type ExecutionEventOrigin = "manual" | "webhook" | "scheduled" | "event" | "subworkflow" | "retry";
export type InternalEventSource = { type: string; id?: string };
export type InternalEventSubject = { type: string; id: string };

export interface DataStoreRecordEventData {
  dataStoreId: string; recordId: string; key: string; version: number; previousVersion?: number;
  value?: unknown; valueOmitted?: boolean; valueSizeBytes?: number;
}
export interface ExecutionEventData {
  executionId: string; workflowId: string; workflowVersionId: string | null; status: "COMPLETED" | "FAILED";
  origin: ExecutionEventOrigin; startedAt: string | null; completedAt: string; durationMs: number | null; parentExecutionId: string | null;
}
export interface ApprovalEventData {
  approvalId: string; executionId: string; workflowId: string; workflowVersionId: string | null; stepKey: string;
  outcome: "APPROVED" | "REJECTED" | "EXPIRED"; requestedAt: string; decidedAt: string;
}
export interface InternalEventDataByType {
  DATA_STORE_RECORD_CREATED: DataStoreRecordEventData;
  DATA_STORE_RECORD_UPDATED: DataStoreRecordEventData;
  DATA_STORE_RECORD_DELETED: DataStoreRecordEventData;
  EXECUTION_COMPLETED: ExecutionEventData;
  EXECUTION_FAILED: ExecutionEventData;
  APPROVAL_APPROVED: ApprovalEventData;
  APPROVAL_REJECTED: ApprovalEventData;
  APPROVAL_EXPIRED: ApprovalEventData;
}
export interface InternalEventEnvelope<T extends InternalEventType = InternalEventType> {
  id: string; schemaVersion: 1; type: T; organizationId: string; occurredAt: string;
  source: InternalEventSource; subject: InternalEventSubject; correlationId: string;
  rootEventId: string; causationId: string | null; depth: number; data: InternalEventDataByType[T];
}
export type EventTriggerFilters = { dataStoreId?: string; keyPrefix?: string; workflowId?: string; origin?: ExecutionEventOrigin };

export const INTERNAL_EVENT_LIMITS = {
  envelopeBytes: 65_536, dataBytes: 32_768, maxDepth: 8, maxKeys: 500,
  maxArrayLength: 100, maxStringLength: 8_192, maxChainEvents: 100
} as const;

const EXECUTION_ORIGINS = new Set<ExecutionEventOrigin>(["manual", "webhook", "scheduled", "event", "subworkflow", "retry"]);
const SENSITIVE_KEYS = ["authorization", "cookie", "token", "password", "secret", "credential", "apikey", "encryptedvalue", "headers", "contextjson"];

export function isInternalEventType(value: unknown): value is InternalEventType {
  return typeof value === "string" && (INTERNAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function normalizeEventTriggerFilters(eventType: InternalEventType, value: unknown): EventTriggerFilters {
  const input = record(value);
  const allowed = eventType.startsWith("DATA_STORE_") ? new Set(["dataStoreId", "keyPrefix"])
    : eventType.startsWith("EXECUTION_") ? new Set(["workflowId", "origin"]) : new Set(["workflowId"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported filter ${key} for ${eventType}`);
  const filters: EventTriggerFilters = {};
  if (input.dataStoreId !== undefined) filters.dataStoreId = requiredString(input.dataStoreId, "dataStoreId", 128);
  if (input.keyPrefix !== undefined) filters.keyPrefix = requiredString(input.keyPrefix, "keyPrefix", 256);
  if (input.workflowId !== undefined) filters.workflowId = requiredString(input.workflowId, "workflowId", 128);
  if (input.origin !== undefined) {
    if (!EXECUTION_ORIGINS.has(input.origin as ExecutionEventOrigin)) throw new Error("Invalid execution origin filter");
    filters.origin = input.origin as ExecutionEventOrigin;
  }
  return filters;
}

export function matchesInternalEvent(event: InternalEventEnvelope, filters: EventTriggerFilters): boolean {
  const data = event.data as unknown as Record<string, unknown>;
  if (filters.dataStoreId && data.dataStoreId !== filters.dataStoreId) return false;
  if (filters.keyPrefix && (typeof data.key !== "string" || !data.key.startsWith(filters.keyPrefix))) return false;
  if (filters.workflowId && data.workflowId !== filters.workflowId) return false;
  if (filters.origin && data.origin !== filters.origin) return false;
  return true;
}

export function sanitizeInternalEventData(value: unknown): { data: Record<string, unknown>; omitted: boolean; originalBytes: number } {
  const originalBytes = jsonBytes(value);
  const state = { keys: 0, omitted: false };
  let data = record(sanitize(value, 0, state));
  if (jsonBytes(data) > INTERNAL_EVENT_LIMITS.dataBytes) {
    data = { valueOmitted: true, valueSizeBytes: originalBytes };
    state.omitted = true;
  }
  return { data, omitted: state.omitted, originalBytes };
}

function sanitize(value: unknown, depth: number, state: { keys: number; omitted: boolean }): unknown {
  if (depth > INTERNAL_EVENT_LIMITS.maxDepth) { state.omitted = true; return "[TRUNCATED]"; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") { if (value.length > INTERNAL_EVENT_LIMITS.maxStringLength) state.omitted = true; return value.slice(0, INTERNAL_EVENT_LIMITS.maxStringLength); }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) { if (value.length > INTERNAL_EVENT_LIMITS.maxArrayLength) state.omitted = true; return value.slice(0, INTERNAL_EVENT_LIMITS.maxArrayLength).map((entry) => sanitize(entry, depth + 1, state)); }
  if (!value || typeof value !== "object") { state.omitted = true; return null; }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (++state.keys > INTERNAL_EVENT_LIMITS.maxKeys) { state.omitted = true; break; }
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SENSITIVE_KEYS.some((candidate) => normalized.includes(candidate))) { output[key] = "[REDACTED]"; continue; }
    output[key] = sanitize(entry, depth + 1, state);
  }
  return output;
}
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function requiredString(value: unknown, name: string, max: number) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`); return value.trim(); }
function jsonBytes(value: unknown) {
  try {
    const text = JSON.stringify(value); let bytes = 0;
    for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code < 0x80) bytes++; else if (code < 0x800) bytes += 2; else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; } else bytes += 3; }
    return bytes;
  } catch { return INTERNAL_EVENT_LIMITS.dataBytes + 1; }
}
