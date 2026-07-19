import { StepType, type ReplaySafetyClass, type ReplayStepSummary } from "@automation/shared-types";

const PURE = new Set<string>([StepType.Transform, StepType.Conditional, StepType.If, StepType.Switch, StepType.GetVariable, StepType.ReturnWorkflowOutput]);
const READ_ONLY = new Set<string>([StepType.DataStoreGetRecord, StepType.DataStoreExistsRecord, StepType.DataStoreCountRecords, StepType.DataStoreListRecords, StepType.AiClassification, StepType.AiStructuredExtraction, StepType.AiSummary]);
const CONTROL = new Set<string>([StepType.Approval, StepType.Delay, StepType.WaitUntil, StepType.ForEach, StepType.TryCatch]);

export function replaySafety(stepType: string, config: unknown): ReplaySafetyClass {
  if (stepType === StepType.HttpRequest) {
    const method = String(record(config).method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD" ? "READ_ONLY" : "SIDE_EFFECT";
  }
  if (PURE.has(stepType)) return "PURE";
  if (READ_ONLY.has(stepType)) return "READ_ONLY";
  if (CONTROL.has(stepType)) return "WAITING_CONTROL";
  return "SIDE_EFFECT";
}

export function replayStep(step: { key?: string; stepKey?: string; type?: string; stepType?: string; configJson?: unknown; config?: unknown; executionPath?: string; iterationIndex?: number | null }): ReplayStepSummary {
  const stepType = String(step.type ?? step.stepType ?? "unknown");
  return { stepKey: String(step.key ?? step.stepKey ?? "unknown"), stepType, executionPath: step.executionPath ?? "root", iterationIndex: step.iterationIndex ?? null, safety: replaySafety(stepType, step.configJson ?? step.config) };
}

export function containsUnavailableRecoveryValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value === "[redacted]" || value === "[REDACTED]" || value === "[TRUNCATED]";
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Array.isArray(value) && (value as any).truncated === true) return true;
  return (Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)).some((entry) => containsUnavailableRecoveryValue(entry, seen));
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
