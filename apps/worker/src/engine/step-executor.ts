import { Injectable } from "@nestjs/common";
import { FOR_EACH_LIMITS, StepExecutionStatus, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { sanitizeForLog } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepRegistry } from "./step-registry";
import { ErrorClassifier } from "./error-classifier";
import { RetryPolicyResolver, type RetryPolicy } from "./retry-policy-resolver";
import { JobContextService } from "../observability/job-context.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService, workerErrorCategory } from "../metrics/worker-metrics.service";
import { ExpressionResolver } from "./expression-resolver";
import { TestRuntimePolicy } from "./test-runtime-policy";
import { DebugArtifactRecorder } from "./debug-artifact-recorder";

export type StepExecutionRecord = {
  id: string;
  attemptCount: number;
  maxAttempts: number;
  status: string;
  nextRetryAt?: Date | null;
  effectKey: string | null;
  effectStatus: string | null;
  outputJson?: unknown;
  executionPath?: string;
  iterationIndex?: number | null;
};

@Injectable()
export class StepExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StepRegistry,
    private readonly errorClassifier: ErrorClassifier,
    private readonly retryPolicyResolver: RetryPolicyResolver,
    private readonly expressionResolver?: ExpressionResolver,
    private readonly testRuntime?: TestRuntimePolicy,
    private readonly debugRecorder?: DebugArtifactRecorder,
    private readonly jobContext?: JobContextService,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
  ) {}

  async ensure(input: {
    organizationId: string;
    executionId: string;
    workflowStepId?: string | null;
    step: WorkflowStepDefinition;
    executionPath?: string;
    iterationIndex?: number | null;
  }) {
    const executionPath = input.executionPath ?? "root";
    const policy = this.retryPolicyResolver.resolve(input.step);
    const effectKey = `flowmind:${input.executionId}:${executionPath}:${input.step.key}`;
    const existing = await this.prisma.stepExecution.findUnique({ where: { executionId_stepKey_executionPath: { executionId: input.executionId, stepKey: input.step.key, executionPath } }, select: { id: true } });
    if (!existing) {
      const count = await this.prisma.stepExecution.count({ where: { executionId: input.executionId } });
      if (count >= FOR_EACH_LIMITS.maxStepExecutions) throw new Error("Execution step limit exceeded");
    }
    return this.prisma.stepExecution.upsert({
      where: { executionId_stepKey_executionPath: { executionId: input.executionId, stepKey: input.step.key, executionPath } },
      update: { maxAttempts: policy.maxAttempts, effectKey, workflowStepId: input.workflowStepId ?? undefined, iterationIndex: input.iterationIndex ?? undefined },
      create: {
        organizationId: input.organizationId,
        executionId: input.executionId,
        workflowStepId: input.workflowStepId ?? undefined,
        stepKey: input.step.key,
        stepType: input.step.type,
        executionPath,
        iterationIndex: input.iterationIndex ?? undefined,
        status: StepExecutionStatus.Pending,
        attempt: 0,
        attemptCount: 0,
        maxAttempts: policy.maxAttempts,
        effectKey,
        inputJson: {}
      }
    });
  }

  async execute(input: {
    organizationId: string;
    executionId: string;
    workflowStepId?: string | null;
    step: WorkflowStepDefinition;
    context: any;
    stepExecution: StepExecutionRecord;
    executionPath?: string;
    iterationIndex?: number | null;
  }) {
    const policy = this.retryPolicyResolver.resolve(input.step);
    const startedAt = new Date();
    const nextAttempt = input.stepExecution.attemptCount + 1;
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Running,
        attempt: nextAttempt,
        attemptCount: nextAttempt,
        maxAttempts: policy.maxAttempts,
        startedAt,
        completedAt: null,
        nextRetryAt: null,
        workerId: workerId(),
        inputJson: {}
      }
    });
    this.logger?.info("worker.step.started", {
      stepExecutionId: input.stepExecution.id,
      stepKey: input.step.key,
      stepType: input.step.type,
      attemptCount: nextAttempt,
      maxAttempts: policy.maxAttempts
    });

    try {
      const trace = this.jobContext?.getContext();
      input.context.metadata = {
        ...(input.context.metadata ?? {}),
        runtime: {
          organizationId: input.organizationId,
          executionId: input.executionId,
          workflowStepId: input.workflowStepId,
          stepExecutionId: input.stepExecution.id,
          effectKey: input.stepExecution.effectKey ?? `flowmind:${input.executionId}:${input.executionPath ?? "root"}:${input.step.key}`,
          executionPath: input.executionPath ?? input.stepExecution.executionPath ?? "root",
          iterationIndex: input.iterationIndex ?? input.stepExecution.iterationIndex ?? null,
          requestId: trace?.requestId,
          correlationId: trace?.correlationId
        }
      };
      input.context.connection = await this.safeConnectionMetadata(input.organizationId, input.step.config);
      const mode = input.context.metadata?.expressionMode === "strict" ? "strict" : "legacy";
      const shouldResolveConfigBeforeHandler = input.step.type !== StepType.Transform && !isVariableStep(input.step.type);
      const resolvedConfig = shouldResolveConfigBeforeHandler && this.expressionResolver
        ? this.expressionResolver.resolveValue(input.step.config, input.context, { mode })
        : input.step.config;
      const resolvedStep = { ...input.step, config: resolvedConfig as Record<string, unknown> };
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: { inputJson: toJson(sanitizePersisted({ config: resolvedConfig })) }
      });
      await this.debugRecorder?.record(input.stepExecution.id, {
        originalConfig: input.step.config,
        resolvedConfig,
        expressions: collectExpressions(input.step.config, resolvedConfig),
        resolvedVariables: collectExpressions(input.step.config, resolvedConfig).map((entry) => ({
          path: entry.expression.replace(/^\{\{\s*|\s*\}\}$/g, ""),
          original: entry.expression,
          resolved: entry.result,
          origin: entry.expression.split(".")[0]?.replace(/^\{\{\s*/, "") ?? "unknown"
        })),
        connection: input.context.connection ?? {}
      });
      const decision = await this.testRuntime?.decide({ executionId: input.executionId, step: input.step, resolvedConfig: resolvedStep.config });
      if (decision?.kind === "error") {
        throw decision.error;
      }
      const handler = this.registry.get(input.step.type);
      const result =
        decision?.kind === "mock"
          ? decision.result
          : await withTimeout(handler.execute(resolvedStep, input.context), policy.timeoutSeconds * 1000);
      if (input.step.type === StepType.Transform) {
        await this.debugRecorder?.record(input.stepExecution.id, transformDebugArtifact(input.step.config, result.output));
      }
      if (isDataStoreStep(input.step.type)) {
        await this.debugRecorder?.record(input.stepExecution.id, dataStoreDebugArtifact(resolvedStep.config, result.output));
      }
      if (isVariableStep(input.step.type)) {
        await this.debugRecorder?.record(input.stepExecution.id, variableDebugArtifact(input.step.type, resolvedStep.config, result.output));
      }
      const completedAt = new Date();
      const control = result.control;
      const waitUntil = control?.waitUntil ? new Date(control.waitUntil) : null;
      if (waitUntil && Number.isFinite(waitUntil.getTime()) && waitUntil > completedAt) {
        await this.prisma.stepExecution.update({
          where: { id: input.stepExecution.id },
          data: {
            status: StepExecutionStatus.Retrying,
            outputJson: toJson(sanitizePersisted(result.output)),
            errorJson: Prisma.JsonNull,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            nextRetryAt: waitUntil,
            effectStatus: control?.waitReason ?? "waiting"
          }
        });
        this.logger?.info(control?.waitReason === "wait_until" ? "worker.flow.wait_until_scheduled" : "worker.flow.delay_scheduled", {
          stepExecutionId: input.stepExecution.id,
          stepKey: input.step.key,
          stepType: input.step.type,
          nextRetryAt: waitUntil
        });
        this.metrics?.recordWait(input.step.type, control?.waitReason ?? "delay", Math.max(0, (waitUntil.getTime() - completedAt.getTime()) / 1000));
        return { outcome: "retrying" as const, nextRetryAt: waitUntil };
      }
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: {
          status: result.status,
          outputJson: toJson(sanitizePersisted(result.output)),
          errorJson: Prisma.JsonNull,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          effectStatus: "succeeded"
        }
      });
      this.logger?.info("worker.step.completed", {
        stepExecutionId: input.stepExecution.id,
        stepKey: input.step.key,
        stepType: input.step.type,
        durationMs: completedAt.getTime() - startedAt.getTime()
      });
      this.metrics?.recordStep(input.step.type, "completed", (completedAt.getTime() - startedAt.getTime()) / 1000);
      if (input.step.type === StepType.Transform) {
        this.metrics?.recordTransform(String(input.step.config.mode ?? ""), "success", (completedAt.getTime() - startedAt.getTime()) / 1000);
      }
      if (isVariableStep(input.step.type)) {
        this.metrics?.recordVariable(variableOperation(input.step.type), "success", (completedAt.getTime() - startedAt.getTime()) / 1000);
        await this.recordVariableAudit(input.organizationId, input.executionId, input.stepExecution.id, input.step.type, result.output);
      }
      return { result, outcome: "completed" as const };
    } catch (error) {
      const completedAt = new Date();
      const classification = this.errorClassifier.classify(error);
      if (input.step.type === StepType.Transform) {
        await this.debugRecorder?.record(input.stepExecution.id, transformDebugArtifact(input.step.config, undefined, error)).catch(() => undefined);
      }
      const canRetry = classification === "retryable" && nextAttempt < policy.maxAttempts;
      const nextRetryAt = canRetry ? this.retryPolicyResolver.nextRetryAt(policy, nextAttempt, completedAt) : null;
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: {
          status: canRetry ? StepExecutionStatus.Retrying : StepExecutionStatus.Failed,
          errorJson: toJson(sanitizePersisted(serializeError(error, classification))),
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          nextRetryAt,
          effectStatus: classification === "ambiguous" ? "ambiguous" : "failed"
        }
      });
      this.logger?.warn(classification === "ambiguous" ? "worker.effect.ambiguous" : "worker.step.failed", {
        stepExecutionId: input.stepExecution.id,
        stepKey: input.step.key,
        stepType: input.step.type,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        errorCategory: classification,
        retrying: canRetry
      });
      if (canRetry) {
        this.metrics?.recordStep(input.step.type, "retry_scheduled", (completedAt.getTime() - startedAt.getTime()) / 1000, workerErrorCategory(classification));
        return { outcome: "retrying" as const, nextRetryAt: nextRetryAt as Date };
      }
      this.metrics?.recordStep(
        input.step.type,
        classification === "ambiguous" ? "ambiguous" : "failed",
        (completedAt.getTime() - startedAt.getTime()) / 1000,
        workerErrorCategory(classification)
      );
      if (input.step.type === StepType.Transform) {
        this.metrics?.recordTransform(String(input.step.config.mode ?? ""), "failure", (completedAt.getTime() - startedAt.getTime()) / 1000, transformFailureCategory(error));
      }
      if (isVariableStep(input.step.type)) {
        this.metrics?.recordVariable(variableOperation(input.step.type), "error", (completedAt.getTime() - startedAt.getTime()) / 1000, workerErrorCategory(classification));
      }
      throw error;
    }
  }

  async skip(input: {
    organizationId: string;
    executionId: string;
    workflowStepId?: string | null;
    step: WorkflowStepDefinition;
    stepExecution: StepExecutionRecord;
    reason: string;
  }) {
    const now = new Date();
    const output = { skipped: true, reason: input.reason };
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Skipped,
        inputJson: toJson({ reason: input.reason }),
        outputJson: toJson(sanitizePersisted(output)),
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        effectStatus: "skipped"
      }
    });
    this.metrics?.recordStep(input.step.type, "skipped", 0);
    return {
      result: { status: StepExecutionStatus.Skipped, output }
    };
  }

  async completeWait(input: { step: WorkflowStepDefinition; stepExecution: StepExecutionRecord }) {
    const now = new Date();
    const output = input.stepExecution.outputJson ?? { resumed: true };
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Completed,
        outputJson: toJson(sanitizePersisted(output)),
        errorJson: Prisma.JsonNull,
        completedAt: now,
        nextRetryAt: null,
        durationMs: 0,
        effectStatus: "succeeded"
      }
    });
    this.logger?.info("worker.flow.wait_resumed", {
      stepExecutionId: input.stepExecution.id,
      stepKey: input.step.key,
      stepType: input.step.type
    });
    this.metrics?.recordStep(input.step.type, "completed", 0);
    return { result: { status: StepExecutionStatus.Completed, output } };
  }

  private async safeConnectionMetadata(organizationId: string, config: Record<string, unknown>) {
    const connectionId = typeof config.connectionId === "string" ? config.connectionId : undefined;
    if (!connectionId) return {};
    const connection = await this.prisma.connection.findFirst({
      where: { id: connectionId, organizationId, deletedAt: null },
      select: { id: true, name: true, type: true, status: true, configJson: true }
    });
    if (!connection) return {};
    return {
      id: connection.id,
      name: connection.name,
      type: connection.type === "smtp" ? "SMTP" : "HTTP",
      authScheme: connection.type === "smtp" ? undefined : safeHttpAuthScheme(connection.configJson),
      status: connection.status
    };
  }

  private async recordVariableAudit(organizationId: string, executionId: string, stepExecutionId: string, stepType: string, output: unknown) {
    const operation = variableOperation(stepType);
    if (operation === "get") return;
    const result = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: `variable.${operation}`,
        resourceType: "Execution",
        resourceId: executionId,
        correlationId: this.jobContext?.getContext()?.correlationId ?? null,
        metadataJson: toJson({
          stepExecutionId,
          operation: operation.toUpperCase(),
          scope: typeof result.scope === "string" ? result.scope : undefined,
          name: typeof result.name === "string" ? result.name : undefined,
          type: typeof result.type === "string" ? result.type : undefined,
          exists: typeof result.exists === "boolean" ? result.exists : undefined
        })
      }
    }).catch(() => undefined);
  }
}

function collectExpressions(original: unknown, resolved: unknown, path = ""): Array<{ expression: string; result: unknown; type: string }> {
  if (typeof original === "string" && original.includes("{{")) {
    return [{ expression: original, result: resolved, type: Array.isArray(resolved) ? "array" : resolved === null ? "null" : typeof resolved }];
  }
  if (!original || typeof original !== "object" || Array.isArray(original)) return [];
  const resolvedRecord = resolved && typeof resolved === "object" && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : {};
  return Object.entries(original as Record<string, unknown>).flatMap(([key, value]) => collectExpressions(value, resolvedRecord[key], path ? `${path}.${key}` : key));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function serializeError(error: unknown, classification: string) {
  return {
    message: error instanceof Error ? error.message : String(error),
    classification,
    ...(isStructuredStepError(error) ? { code: (error as any).code } : {})
  };
}

function transformDebugArtifact(config: Record<string, unknown>, output?: unknown, error?: unknown) {
  return {
    originalConfig: config,
    resolvedConfig: config,
    expressions: collectExpressions(config, config),
    resolvedVariables: collectExpressions(config, config).map((entry) => ({
      path: entry.expression.replace(/^\{\{\s*|\s*\}\}$/g, ""),
      original: entry.expression,
      resolved: entry.result,
      origin: entry.expression.split(".")[0]?.replace(/^\{\{\s*/, "") ?? "unknown"
    })),
    transform: {
      mode: typeof config.mode === "string" ? config.mode : "unknown",
      source: transformSourcePreview(config),
      output: transformDebugValue(output),
      error: error ? serializeError(error, "non_retryable") : undefined
    }
  };
}

function transformSourcePreview(config: Record<string, unknown>) {
  if ("source" in config) return config.source;
  if ("mergeSources" in config) return config.mergeSources;
  if ("fields" in config) return config.fields;
  return undefined;
}

function transformFailureCategory(error: unknown) {
  const code = isStructuredStepError(error) ? String((error as any).code).toLowerCase() : "";
  if (code) return code;
  return "unknown";
}

function transformDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, preview: value.slice(0, 5).map((entry) => limitValue(entry)) };
  }
  return limitValue(value);
}

function isDataStoreStep(type: string) {
  return String(type).startsWith("data_store_");
}

function isVariableStep(type: string) {
  return [
    StepType.SetVariable,
    StepType.GetVariable,
    StepType.DeleteVariable,
    StepType.IncrementVariable,
    StepType.AppendVariable
  ].includes(type as StepType);
}

function dataStoreDebugArtifact(config: Record<string, unknown>, output: unknown) {
  const result = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  return {
    resolvedConfig: dataStoreSafeConfig(config),
    dataStore: {
      operation: dataStoreOperation(config, result),
      key: typeof config.key === "string" ? config.key : undefined,
      found: result.found,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      existed: result.existed,
      exists: result.exists,
      count: result.count,
      version: result.version,
      list: Array.isArray(result.items) ? { items: result.items.length, hasMore: result.hasMore, limit: result.limit, offset: result.offset } : undefined,
      result: {
        found: result.found,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        existed: result.existed,
        exists: result.exists,
        count: result.count,
        version: result.version,
        list: Array.isArray(result.items) ? { items: result.items.length, hasMore: result.hasMore, limit: result.limit, offset: result.offset } : undefined
      }
    }
  };
}

function dataStoreOperation(config: Record<string, unknown>, output: Record<string, unknown>) {
  if ("created" in output || "updated" in output) return "upsert";
  if ("deleted" in output) return "delete";
  if ("exists" in output) return "exists";
  if ("count" in output) return "count";
  if ("items" in output) return "list";
  if ("found" in output) return "get";
  return String(config.operation ?? "unknown");
}

function variableDebugArtifact(stepType: string, config: Record<string, unknown>, output: unknown) {
  const result = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  return {
    resolvedConfig: variableSafeConfig(config),
    variable: {
      operation: variableOperation(stepType).toUpperCase(),
      scope: typeof result.scope === "string" ? result.scope : config.scope,
      name: typeof result.name === "string" ? result.name : config.name,
      type: typeof result.type === "string" ? result.type : undefined,
      exists: typeof result.exists === "boolean" ? result.exists : undefined,
      summary: result.summary
    }
  };
}

function variableSafeConfig(config: Record<string, unknown>) {
  return {
    scope: typeof config.scope === "string" ? config.scope : undefined,
    name: typeof config.name === "string" ? config.name : undefined,
    hasValue: Object.prototype.hasOwnProperty.call(config, "value"),
    hasExpression: typeof config.expression === "string" && Boolean(config.expression.trim()),
    hasAmount: Object.prototype.hasOwnProperty.call(config, "amount") || Object.prototype.hasOwnProperty.call(config, "amountExpression")
  };
}

function variableOperation(stepType: string) {
  switch (stepType) {
    case StepType.SetVariable:
      return "set";
    case StepType.GetVariable:
      return "get";
    case StepType.DeleteVariable:
      return "delete";
    case StepType.IncrementVariable:
      return "increment";
    case StepType.AppendVariable:
      return "append";
    default:
      return "unknown";
  }
}

function dataStoreSafeConfig(config: Record<string, unknown>) {
  return {
    dataStoreId: config.dataStoreId,
    dataStoreName: config.dataStoreName,
    key: config.key,
    keyPrefix: config.keyPrefix,
    mode: config.mode,
    ttlSeconds: config.ttlSeconds,
    optimisticConcurrency: config.optimisticConcurrency,
    expectedVersion: config.expectedVersion,
    limit: config.limit,
    offset: config.offset,
    sortBy: config.sortBy,
    direction: config.direction
  };
}

function isStructuredStepError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && typeof (error as any).code === "string");
}

const SENSITIVE_WORDS = /(^|[^a-z0-9])(authorization|cookie|token|secret|password|api[-_ ]?key)([^a-z0-9]|$)/i;

function sanitizePersisted(value: unknown): unknown {
  return sanitizeForLog(limitValue(redact(value)), { maxBytes: Number(process.env.PERSISTED_EXECUTION_PAYLOAD_MAX_BYTES ?? 65_536) });
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return SENSITIVE_WORDS.test(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redact(entry, seen)
    ])
  );
}

function isSensitiveKey(key: string) {
  return /^(authorization|cookie|setcookie|password|token|secret|apikey|xapikey|accesstoken|refreshtoken|encryptedvalue|ciphertext|authtag|iv|smtppassword)$/i.test(
    key.replace(/[-_]/g, "")
  );
}

function safeHttpAuthScheme(value: unknown) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const scheme = String(config.authScheme ?? "API_KEY");
  if (scheme === "BEARER_TOKEN") return "BEARER";
  if (scheme === "BASIC_AUTH") return "BASIC";
  return ["API_KEY", "BEARER", "BASIC", "CUSTOM_HEADERS"].includes(scheme) ? scheme : "API_KEY";
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
    const preview = value.slice(0, limit).map((entry) => limitValue(entry, depth + 1));
    return value.length > limit ? { truncated: true, originalSize: value.length, limit, preview } : preview;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, limitValue(entry, depth + 1)]));
}

function workerId() {
  return process.env.WORKER_ID ?? `${process.pid}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
