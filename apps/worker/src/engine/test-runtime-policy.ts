import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";

type TestStepMock = {
  behavior?: "manual" | "simulated_success" | "simulated_error" | "simulated_timeout";
  output?: unknown;
  error?: { message?: string; code?: string };
  timeoutMs?: number;
  http?: { status?: number; headers?: Record<string, string>; body?: unknown };
  ai?: { response?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number };
};

export type TestRuntimeDecision =
  | { kind: "run_real" }
  | { kind: "mock"; result: StepResult }
  | { kind: "error"; error: Error };

@Injectable()
export class TestRuntimePolicy {
  constructor(private readonly prisma: PrismaService) {}

  async decide(input: { executionId: string; step: WorkflowStepDefinition; resolvedConfig: Record<string, unknown> }): Promise<TestRuntimeDecision> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: input.executionId },
      select: {
        executionMode: true,
        testRun: { select: { externalMode: true, stepMocksJson: true } }
      }
    });
    if (execution?.executionMode !== "TEST" || !execution.testRun) {
      return { kind: "run_real" };
    }
    const mocks = asRecord(execution.testRun.stepMocksJson);
    const mock = asRecord(mocks[input.step.key]) as TestStepMock;
    if (mock.behavior === "simulated_timeout") {
      return { kind: "error", error: new Error(`Simulated timeout for ${input.step.key}`) };
    }
    if (mock.behavior === "simulated_error") {
      return { kind: "error", error: new Error(mock.error?.message ?? `Simulated error for ${input.step.key}`) };
    }
    if (execution.testRun.externalMode === "real" && input.step.type !== StepType.DatabaseRecord && !mock.behavior) {
      return { kind: "run_real" };
    }
    if (!isEffectStep(input.step.type)) {
      return { kind: "run_real" };
    }
    return { kind: "mock", result: mockResult(input.step, input.resolvedConfig, mock) };
  }
}

function mockResult(step: WorkflowStepDefinition, resolvedConfig: Record<string, unknown>, mock: TestStepMock): StepResult {
  if (mock.output !== undefined && (mock.behavior === "manual" || mock.behavior === "simulated_success")) {
    return { status: StepExecutionStatus.Completed, output: { simulated: true, stepKey: step.key, value: mock.output } };
  }
  if (step.type === StepType.HttpRequest) {
    const http = mock.http ?? {};
    const status = Number(http.status ?? 200);
    return { status: StepExecutionStatus.Completed, output: { simulated: true, kind: "http", status, ok: status >= 200 && status < 300, headers: http.headers ?? {}, body: http.body ?? {} } };
  }
  if (step.type === StepType.EmailNotification) {
    return {
      status: StepExecutionStatus.Completed,
      output: {
        previewOnly: true,
        simulated: true,
        to: resolvedConfig.to,
        from: resolvedConfig.from,
        subject: resolvedConfig.subject,
        text: resolvedConfig.text,
        html: resolvedConfig.html
      }
    };
  }
    if (step.type === StepType.DatabaseRecord) {
    return {
      status: StepExecutionStatus.Completed,
      output: {
        dryRun: true,
        simulated: true,
        collection: resolvedConfig.collection,
        data: resolvedConfig.data,
        wouldPersist: true
      }
      };
    }
  if (isDataStoreStep(step.type)) {
    return {
      status: StepExecutionStatus.Completed,
      output: {
        dryRun: true,
        simulated: true,
        operation: step.type,
        key: resolvedConfig.key,
        wouldPersist: step.type === StepType.DataStoreUpsertRecord || step.type === StepType.DataStoreDeleteRecord
      }
    };
  }
  if (String(step.type).startsWith("ai_")) {
    const ai = mock.ai ?? {};
    return {
      status: StepExecutionStatus.Completed,
      output: {
        response: ai.response ?? {},
        inputTokens: ai.inputTokens ?? 0,
        outputTokens: ai.outputTokens ?? 0,
        costUsd: ai.costUsd ?? 0,
        mock: true,
        simulated: true
      }
    };
  }
  return { status: StepExecutionStatus.Completed, output: { simulated: true, stepKey: step.key, value: mock.output ?? {} } };
}

function isEffectStep(type: string) {
  return type === StepType.HttpRequest || type === StepType.EmailNotification || type === StepType.DatabaseRecord || isDataStoreStep(type) || type.startsWith("ai_");
}

function isDataStoreStep(type: string) {
  return [
    StepType.DataStoreGetRecord,
    StepType.DataStoreUpsertRecord,
    StepType.DataStoreDeleteRecord,
    StepType.DataStoreExistsRecord,
    StepType.DataStoreCountRecords,
    StepType.DataStoreListRecords
  ].includes(type as StepType);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
