import { Injectable } from "@nestjs/common";
import type { WorkflowStepDefinition } from "@automation/shared-types";

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  strategy: "fixed" | "exponential";
  timeoutSeconds: number;
};

@Injectable()
export class RetryPolicyResolver {
  resolve(step: WorkflowStepDefinition): RetryPolicy {
    const policy = normalizeRetryPolicy((step.retryPolicy ?? {}) as Record<string, unknown>);
    return {
      maxAttempts: policy.maxAttempts,
      backoffMs: policy.backoffMs,
      strategy: policy.strategy,
      timeoutSeconds: clampNumber(step.timeoutSeconds ?? defaultTimeout(step.type), 1, 120)
    };
  }

  nextRetryAt(policy: RetryPolicy, attemptCount: number, now = new Date()) {
    const multiplier = policy.strategy === "exponential" ? Math.max(1, 2 ** Math.max(0, attemptCount - 1)) : 1;
    return new Date(now.getTime() + Math.min(policy.backoffMs * multiplier, 60_000));
  }
}

export function normalizeRetryPolicy(raw: Record<string, unknown> | undefined): Omit<RetryPolicy, "timeoutSeconds"> {
  const retry = isRecord(raw?.retry) ? raw.retry : raw;
  return {
    maxAttempts: clampNumber(Number(retry?.maxAttempts ?? 1), 1, 5),
    backoffMs: clampNumber(Number(retry?.backoffMs ?? 1000), 100, 60_000),
    strategy: retry?.strategy === "exponential" ? "exponential" : "fixed"
  };
}

export function normalizeTimeoutSeconds(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampNumber(Number(value), 1, 120);
}

function defaultTimeout(type: string) {
  return type.startsWith("ai_") ? 60 : type === "http_request" ? 15 : 30;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
