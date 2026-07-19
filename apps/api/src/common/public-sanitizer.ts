import { sanitizeForLog } from "@automation/observability";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "xapikey",
  "secret",
  "secretvalue",
  "connectionsecret",
  "password",
  "smtppassword",
  "smtpcredentials",
  "connectionstring",
  "token",
  "tokenhash",
  "passwordhash",
  "ipaddress",
  "iphash",
  "encryptedvalue",
  "ciphertext",
  "authtag",
  "iv",
  "encryptionkey",
  "stack",
  "stacktrace",
  "cause",
  "requestbody",
  "responsebody",
  "providerresponse",
  "providerrequest"
]);

export function sanitizePublic(value: unknown): unknown {
  return sanitizeForLog(limitValue(redact(value)), { maxBytes: publicPayloadBytes() });
}

export function publicError(value: unknown) {
  const sanitized = sanitizePublic(value);
  const record = sanitized && typeof sanitized === "object" ? (sanitized as Record<string, unknown>) : {};
  const category = publicErrorCategory(record.classification ?? record.category ?? record.errorCategory);
  return {
    category,
    code: publicErrorCode(record.code, category),
    messageSafe: publicErrorMessage(record.message, category)
  };
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return containsSensitiveWord(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.has(normalizeKey(key)) ? "[redacted]" : redact(entry, seen)
    ])
  );
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function publicErrorCategory(value: unknown) {
  const raw = String(value ?? "unknown").toLowerCase();
  if (["timeout", "validation", "authentication", "authorization", "rate_limit", "connection", "external_4xx", "external_5xx", "ssrf", "configuration", "database", "redis"].includes(raw)) {
    return raw;
  }
  if (raw === "retryable") return "connection";
  if (raw === "non_retryable") return "validation";
  if (raw === "ambiguous") return "ambiguous_effect";
  return "unknown";
}

function publicErrorCode(value: unknown, category: string) {
  const raw = typeof value === "string" && /^[A-Z0-9_:-]{2,64}$/.test(value) ? value : undefined;
  if (raw) return raw;
  const defaults: Record<string, string> = {
    timeout: "STEP_TIMEOUT",
    validation: "STEP_VALIDATION_FAILED",
    authentication: "AUTHENTICATION_FAILED",
    authorization: "AUTHORIZATION_FAILED",
    rate_limit: "RATE_LIMITED",
    connection: "CONNECTION_FAILED",
    external_4xx: "EXTERNAL_REQUEST_REJECTED",
    external_5xx: "EXTERNAL_SERVICE_FAILED",
    ssrf: "SSRF_BLOCKED",
    configuration: "CONFIGURATION_ERROR",
    ambiguous_effect: "AMBIGUOUS_EFFECT",
    database: "DATABASE_ERROR",
    redis: "QUEUE_ERROR",
    unknown: "UNKNOWN_ERROR"
  };
  return defaults[category] ?? defaults.unknown;
}

function publicErrorMessage(value: unknown, category: string) {
  if (typeof value === "string" && value.length > 0 && value.length <= 240 && !containsSensitiveWord(value)) {
    return value;
  }
  const defaults: Record<string, string> = {
    timeout: "The step exceeded its configured timeout.",
    validation: "The step failed validation.",
    authentication: "The step could not authenticate with the target service.",
    authorization: "The step was not authorized by the target service.",
    rate_limit: "The target service rate limited the step.",
    connection: "The step could not reach the target service.",
    external_4xx: "The target service rejected the request.",
    external_5xx: "The target service failed while processing the request.",
    ssrf: "The request was blocked by outbound request safety rules.",
    configuration: "The step configuration is invalid.",
    ambiguous_effect: "The step effect may have completed, but Flowmind could not confirm it.",
    database: "The database operation failed.",
    redis: "The queue operation failed.",
    unknown: "The step failed for an unknown reason."
  };
  return defaults[category] ?? defaults.unknown;
}

function containsSensitiveWord(value: string) {
  return /(^|[^a-z0-9])(authorization|cookie|token|secret|password|api[-_ ]?key|bearer|basic)([^a-z0-9]|$)/i.test(value)
    || /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(value)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(value);
}

function publicPayloadBytes() {
  return Number(process.env.PUBLIC_EXECUTION_PAYLOAD_MAX_BYTES ?? 65_536);
}

function limitValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return { truncated: true, reason: "max_depth", limit: 8 };
  if (typeof value === "string") {
    const limit = 16_384;
    if (value.length <= limit) return value;
    return { truncated: true, originalSize: value.length, limit, preview: value.slice(0, limit) };
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const limit = 200;
    const visible = value.slice(0, limit).map((entry) => limitValue(entry, depth + 1));
    return value.length > limit ? { truncated: true, originalSize: value.length, limit, preview: visible } : visible;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, limitValue(entry, depth + 1)]));
}
