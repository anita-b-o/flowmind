import type { ExecutionStatus, JsonObject, StepExecutionStatus, WorkflowDefinition } from "./index";

export type ExecutionMode = "REAL" | "TEST";
export type TestExternalMode = "mock" | "real";
export type WorkflowTestRunSource = "version" | "draft";
export type TestMockBehavior = "manual" | "simulated_success" | "simulated_error" | "simulated_timeout";
export type DebugTimelineStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "RETRYING" | "WAITING" | "SKIPPED" | "FAILED" | "DLQ" | "CANCELLED";
export type DebugNodeStatus = "active" | "completed" | "pending" | "skipped" | "failed" | "retrying" | "waiting" | "dlq";

export interface TestStepMock {
  behavior: TestMockBehavior;
  output?: unknown;
  error?: { message: string; code?: string };
  timeoutMs?: number;
  http?: { status: number; headers?: Record<string, string>; body?: unknown };
  ai?: { response: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface CreateWorkflowTestRunRequest {
  workflowVersionId?: string;
  draftDefinition?: WorkflowDefinition;
  payload: { trigger: JsonObject; metadata?: JsonObject };
  externalMode: TestExternalMode;
  stepMocks?: Record<string, TestStepMock>;
  compareWithLastReal?: boolean;
  realModeConfirmed?: boolean;
}

export interface DebugTimelineEvent {
  id: string;
  status: DebugTimelineStatus;
  stepKey?: string;
  timestamp: string;
  durationMs?: number | null;
  attempt?: number | null;
  message: string;
  nextRetryAt?: string | null;
}

export interface DebugStepInspector {
  stepKey: string;
  stepType: string;
  executionPath: string;
  iterationIndex: number | null;
  status: StepExecutionStatus | "PENDING";
  input: unknown;
  resolvedVariables: Array<{ path: string; original?: unknown; resolved: unknown; origin: string }>;
  expressions: Array<{ expression: string; result: unknown; type: string }>;
  resolvedConfig: unknown;
  output: unknown;
  durationMs: number | null;
  retry: { attempt: number; attemptCount: number; maxAttempts: number; nextRetryAt: string | null };
  error: unknown;
  connection: { id?: string; name?: string; type?: string; status?: string } | null;
  variable?: { operation?: string; scope?: string; name?: string; type?: string; exists?: boolean; summary?: unknown } | null;
}

export interface WorkflowTestRunSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string | null;
  executionId: string;
  status: ExecutionStatus;
  externalMode: TestExternalMode;
  source: WorkflowTestRunSource;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdBy?: { id: string; email: string; name?: string | null };
}

export interface WorkflowTestRunDetail extends WorkflowTestRunSummary {
  payload: unknown;
  stepMocks: Record<string, TestStepMock>;
  sideEffectNodes: Array<{ key: string; name: string; type: string; realModeAllowed: boolean }>;
  timeline: DebugTimelineEvent[];
  graph: Record<string, DebugNodeStatus>;
  inspector: Record<string, DebugStepInspector>;
  comparison?: WorkflowTestRunComparison | null;
}

export interface WorkflowTestRunComparison {
  testRunId: string;
  realExecutionId: string | null;
  statusChanged: boolean;
  durationDeltaMs: number | null;
  steps: Array<{
    stepKey: string;
    testStatus: string | null;
    realStatus: string | null;
    durationDeltaMs: number | null;
    outputShapeChanged: boolean;
  }>;
}
