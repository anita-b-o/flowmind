import { randomUUID } from "node:crypto";

const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_MAX_BYTES = 16_384;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "pass",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "x-api-key",
  "secret",
  "secretvalue",
  "connectionsecret",
  "clientsecret",
  "smtppassword",
  "privatekey",
  "encryptedvalue",
  "ciphertext",
  "authtag",
  "iv",
  "encryptionkey"
]);

const SENSITIVE_QUERY_KEYS = new Set(["token", "key", "apikey", "api_key", "secret", "signature", "access_token", "refresh_token"]);

export type TraceContext = {
  requestId: string;
  correlationId: string;
};

export function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

export function traceIdOrNew(value: unknown) {
  return isValidTraceId(value) ? value : randomUUID();
}

export function newTraceId() {
  return randomUUID();
}

export function traceHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function sanitizeHeaders(headers: Record<string, unknown>) {
  return sanitizeForLog(headers) as Record<string, unknown>;
}

export function sanitizeError(error: unknown, maxBytes = errorMaxBytes()) {
  const value =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: process.env.NODE_ENV === "production" ? undefined : error.stack }
      : { message: String(error) };
  return truncateForLog(sanitizeForLog(value), maxBytes);
}

export function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeForLog(value: unknown, options: { maxBytes?: number } = {}): unknown {
  const seen = new WeakSet<object>();
  const sanitized = sanitizeValue(value, seen);
  return truncateForLog(sanitized, options.maxBytes ?? maxLogPayloadBytes());
}

export function truncateForLog(value: unknown, maxBytes = maxLogPayloadBytes()): unknown {
  const serialized = safeStringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maxBytes) {
    return value;
  }
  return {
    truncated: true,
    originalSize: bytes,
    preview: serialized.slice(0, maxBytes)
  };
}

export function pinoRedactPaths() {
  return [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers.set-cookie",
    "password",
    "accessToken",
    "refreshToken",
    "apiKey",
    "secretValue",
    "connectionSecret",
    "smtpPassword",
    "encryptedValue",
    "ciphertext",
    "authTag",
    "iv",
    "encryptionKey",
    "secret",
    "*.password",
    "*.accessToken",
    "*.refreshToken",
    "*.apiKey",
    "*.secretValue",
    "*.connectionSecret",
    "*.smtpPassword",
    "*.encryptedValue",
    "*.ciphertext",
    "*.authTag",
    "*.iv",
    "*.encryptionKey",
    "*.secret"
  ];
}

export function maxLogPayloadBytes() {
  return Number(process.env.MAX_LOG_PAYLOAD_BYTES ?? DEFAULT_MAX_BYTES);
}

export function errorMaxBytes() {
  return Math.min(maxLogPayloadBytes(), 8192);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return maybeSanitizeUrl(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : sanitizeValue(entry, seen)
    ])
  );
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function maybeSanitizeUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? sanitizeUrl(value) : value;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}
