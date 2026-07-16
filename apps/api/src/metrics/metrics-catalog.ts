export const HTTP_ROUTES_EXCLUDED = new Set(["/health", "/health/live", "/health/ready"]);

export const WEBHOOK_REASON_CODES = [
  "accepted",
  "duplicate",
  "invalid_token",
  "inactive_workflow",
  "unsupported_content_type",
  "payload_too_large",
  "rate_limited",
  "enqueue_failed",
  "internal_error"
] as const;

export type WebhookReasonCode = (typeof WEBHOOK_REASON_CODES)[number];
export type WebhookOutcome = "accepted" | "rejected";

export type AuthOutcome = "success" | "invalid_credentials" | "expired" | "revoked" | "reuse_detected" | "invalid_origin" | "error";

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "connection"
  | "external_4xx"
  | "external_5xx"
  | "ssrf"
  | "configuration"
  | "ambiguous_effect"
  | "database"
  | "redis"
  | "unknown";

export function statusClass(statusCode: number) {
  return `${Math.trunc(statusCode / 100)}xx`;
}

export function normalizeRoute(path: string, method = "GET") {
  if (path.includes("?")) {
    path = path.split("?")[0];
  }
  const normalized = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
  if (method === "POST" && /^\/webhooks\/[^/]+\/[^/]+$/.test(path)) {
    return "/webhooks/:workflowId/:token";
  }
  return normalized || "/";
}

export function classifyError(error: unknown): ErrorCategory {
  const status = typeof (error as any)?.status === "number" ? (error as any).status : typeof (error as any)?.statusCode === "number" ? (error as any).statusCode : undefined;
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  if (status && status >= 400 && status < 500) return "external_4xx";
  if (status && status >= 500) return "external_5xx";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("redis")) return "redis";
  if (message.includes("prisma") || message.includes("database")) return "database";
  if (message.includes("econn") || message.includes("socket") || message.includes("connection")) return "connection";
  if (message.includes("ssrf") || message.includes("private, reserved or metadata ip")) return "ssrf";
  if (message.includes("config")) return "configuration";
  if (message.includes("ambiguous")) return "ambiguous_effect";
  return "unknown";
}
