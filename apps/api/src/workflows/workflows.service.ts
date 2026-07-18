import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  assertDataStoreKey,
  assertDataStoreSelector,
  assertDataStoreMetadata,
  assertDataStoreValue,
  assertVariableName,
  assertVariableScope,
  assertVariableValue,
  assertWorkflowVariables,
  DataStoreValidationError,
  normalizeListLimit,
  normalizeOffset,
  StepType,
  ttlSecondsToExpiresAt,
  validateTransformStepConfig,
  WorkflowStatus,
  WorkflowVariableValidationError,
  WorkflowVersionStatus
} from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowVersionDto } from "./dto/create-workflow-version.dto";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ExpressionsService } from "../expressions/expressions.service";
import { graphAvailableStepKeys, validateWorkflowGraph } from "./workflow-graph-validator";

const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 5;
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 60_000;
const TIMEOUT_MIN_SECONDS = 1;
const TIMEOUT_MAX_SECONDS = 120;

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs?: AuditLogsService,
    private readonly expressions?: ExpressionsService
  ) {}

  list(organizationId: string) {
    return this.prisma.workflow.findMany({
      where: { organizationId },
      include: { activeVersion: true },
      orderBy: { updatedAt: "desc" }
    });
  }

  async detail(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId },
      include: {
        activeVersion: true,
        versions: {
          include: {
            createdBy: { select: { id: true, email: true, name: true } },
            steps: { orderBy: { position: "asc" } }
          },
          orderBy: { versionNumber: "asc" }
        }
      }
    });
    if (!workflow) {
      throw new NotFoundException("Workflow not found");
    }
    return workflow;
  }

  create(organizationId: string, createdByUserId: string, dto: CreateWorkflowDto) {
    return this.prisma.workflow.create({
      data: {
        organizationId,
        createdByUserId,
        name: dto.name,
        description: dto.description,
        status: WorkflowStatus.Draft
      }
    });
  }

  async createVersion(
    organizationId: string,
    createdByUserId: string,
    workflowId: string,
    dto: CreateWorkflowVersionDto
  ) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) {
      throw new NotFoundException("Workflow not found");
    }

    const latest = await this.prisma.workflowVersion.findFirst({
      where: { workflowId, organizationId },
      orderBy: { versionNumber: "desc" }
    });
    const schemaVersion = dto.workflowDefinitionSchemaVersion ?? (dto.graph ? 2 : 1);
    if (schemaVersion === 2) {
      validateWorkflowGraph(dto.steps, dto.graph);
    }
    const workflowVariables = this.validateVariableMap(dto.workflowVariables, "workflow variables");
    const environmentVariables = this.validateVariableMap(dto.environmentVariables, "environment variables");
    this.validateStepConfigs(dto.steps);
    await this.validateConnectionReferences(organizationId, [...dto.steps, dto.trigger]);
    this.validateExpressions(dto.steps, schemaVersion === 2 ? dto.graph : undefined);
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const expressionMode = dto.expressionMode ?? "strict";
    const definition = toPrismaJson({
      trigger: dto.trigger,
      steps: dto.steps,
      expressionMode,
      workflowDefinitionSchemaVersion: schemaVersion,
      ...(schemaVersion === 2 ? { graph: dto.graph } : {}),
      ...(dto.ui ? { ui: dto.ui } : {}),
      workflowVariables,
      environmentVariables
    });

    const version = await this.prisma.workflowVersion.create({
      data: {
        organizationId,
        workflowId,
        createdByUserId,
        versionNumber,
        definitionJson: definition,
        steps: {
          createMany: {
            data: [
              {
                organizationId,
                key: dto.trigger.key,
                name: dto.trigger.name,
                type: dto.trigger.type,
                position: 0,
                configJson: toPrismaJson(dto.trigger.config)
              },
              ...dto.steps.map((step, index) => ({
                organizationId,
                key: step.key,
                name: step.name,
                type: step.type,
                position: index + 1,
                configJson: toPrismaJson(step.config),
                retryPolicyJson: step.retryPolicy ? toPrismaJson(normalizeRetryPolicy(step.retryPolicy)) : undefined,
                timeoutSeconds: normalizeTimeoutSeconds(step.timeoutSeconds)
              }))
            ]
          }
        }
      },
      include: { steps: true }
    });
    if (schemaVersion === 2) {
      await this.auditLogs?.record({
        organizationId,
        actorUserId: createdByUserId,
        action: "workflow.version.graph_created",
        resourceType: "WorkflowVersion",
        resourceId: version.id,
        metadata: { workflowId, versionNumber }
      });
    }
    return version;
  }

  async activateVersion(organizationId: string, userId: string, workflowId: string, versionId: string) {
    const version = await this.prisma.workflowVersion.findFirst({
      where: { id: versionId, workflowId, organizationId }
    });
    if (!version) {
      throw new NotFoundException("Workflow version not found");
    }
    const definition = isRecord(version.definitionJson) ? version.definitionJson : {};
    if (definition.workflowDefinitionSchemaVersion === 2) {
      try {
        validateWorkflowGraph((definition.steps as Array<{ key: string; type: string; config: Record<string, unknown> }>) ?? [], definition.graph as Record<string, unknown>);
      } catch (error) {
        await this.auditLogs?.record({
          organizationId,
          actorUserId: userId,
          action: "workflow.activation.graph_rejected",
          resourceType: "WorkflowVersion",
          resourceId: versionId,
          metadata: { workflowId, message: error instanceof Error ? error.message : String(error) }
        });
        throw error;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.updateMany({
        where: { workflowId, organizationId, status: WorkflowVersionStatus.Active },
        data: { status: WorkflowVersionStatus.Archived }
      });
      await tx.workflowVersion.update({
        where: { id: versionId },
        data: { status: WorkflowVersionStatus.Active, activatedAt: new Date() }
      });
      const workflow = await tx.workflow.update({
        where: { id: workflowId },
        data: {
          status: WorkflowStatus.Active,
          activeVersionId: versionId
        },
        include: { activeVersion: true }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "workflow.activated",
          resourceType: "Workflow",
          resourceId: workflowId,
          metadata: { workflowVersionId: versionId, versionNumber: version.versionNumber, workflowDefinitionSchemaVersion: definition.workflowDefinitionSchemaVersion ?? 1 }
        },
        tx
      );
      return workflow;
    });
  }

  private async validateConnectionReferences(organizationId: string, steps: Array<{ type: string; config: Record<string, unknown> }>) {
    for (const step of steps) {
      if (step.type === "http_request") {
        const connectionId = stringValue(step.config.connectionId);
        if (!connectionId) {
          assertNoSensitiveHttpHeaders(step.config);
          continue;
        }
        await this.assertConnection(organizationId, connectionId, "http_api_key");
      }
      if (step.type === "email_notification") {
        const connectionId = stringValue(step.config.connectionId);
        if (!connectionId) {
          if ("password" in step.config || "smtpPassword" in step.config || "host" in step.config || "username" in step.config) {
            throw new BadRequestException("email_notification credentials must use connectionId");
          }
          continue;
        }
        await this.assertConnection(organizationId, connectionId, "smtp");
      }
    }
  }

  private validateExpressions(steps: Array<{ key: string; type: string; config: Record<string, unknown> }>, graph?: Record<string, unknown>) {
    const previous: string[] = [];
    for (const step of steps) {
      const available = graph ? graphAvailableStepKeys(step.key, steps, graph) : previous;
      this.expressions?.validateValue(step.config, available, step.key, step.type === StepType.Transform ? ["item", "index"] : undefined);
      previous.push(step.key);
    }
  }

  private validateStepConfigs(steps: Array<{ type: string; config: Record<string, unknown> }>) {
    for (const step of steps) {
      if (step.type === StepType.Transform) {
        const issues = validateTransformStepConfig(step.config);
        if (issues.length) throw new BadRequestException(issues[0].message);
      }
      if (isDataStoreStep(step.type)) {
        this.validateDataStoreStepConfig(step.type, step.config);
      }
      if (isVariableStep(step.type)) {
        this.validateVariableStepConfig(step.type, step.config);
      }
    }
  }

  private validateVariableMap(value: unknown, label: string) {
    try {
      return assertWorkflowVariables(value ?? {}, label);
    } catch (error) {
      if (error instanceof WorkflowVariableValidationError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private validateVariableStepConfig(type: string, config: Record<string, unknown>) {
    try {
      assertVariableScope(config.scope);
      assertVariableName(config.name);
      if (type === StepType.SetVariable || type === StepType.AppendVariable) {
        const hasValue = Object.prototype.hasOwnProperty.call(config, "value");
        const hasExpression = typeof config.expression === "string" && config.expression.trim();
        if (!hasValue && !hasExpression) throw new WorkflowVariableValidationError("MISSING_VALUE", "Variable value or expression is required.");
        if (hasValue && !containsExpression(config.value)) assertVariableValue(config.value);
      }
      if (type === StepType.IncrementVariable) {
        const amount = config.amount;
        if (amount !== undefined && !(typeof amount === "string" && amount.includes("{{")) && !Number.isFinite(Number(amount))) {
          throw new WorkflowVariableValidationError("INVALID_AMOUNT", "Increment amount must be a finite number.");
        }
      }
    } catch (error) {
      if (error instanceof WorkflowVariableValidationError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async assertConnection(organizationId: string, connectionId: string, type: "http_api_key" | "smtp") {
    const connection = await this.prisma.connection.findFirst({
      where: { id: connectionId, organizationId, type, status: "ACTIVE", deletedAt: null }
    });
    if (!connection) {
      throw new BadRequestException("Workflow step references an invalid connection");
    }
  }

  private validateDataStoreStepConfig(type: string, config: Record<string, unknown>) {
    try {
      if (!selectorHasExpression(config)) assertDataStoreSelector(config);
      if ([StepType.DataStoreGetRecord, StepType.DataStoreUpsertRecord, StepType.DataStoreDeleteRecord, StepType.DataStoreExistsRecord].includes(type as StepType)) {
        if (!(typeof config.key === "string" && config.key.includes("{{"))) assertDataStoreKey(config.key);
      }
      if (type === StepType.DataStoreUpsertRecord) {
        if (config.ttlSeconds !== undefined && !(typeof config.ttlSeconds === "string" && config.ttlSeconds.includes("{{"))) ttlSecondsToExpiresAt(config.ttlSeconds);
        if (config.value !== undefined && !containsExpression(config.value)) assertDataStoreValue(config.value);
        if (config.metadata !== undefined && !containsExpression(config.metadata)) assertDataStoreMetadata(config.metadata);
      }
      if (type === StepType.DataStoreListRecords) {
        if (config.limit !== undefined && !(typeof config.limit === "string" && config.limit.includes("{{"))) normalizeListLimit(config.limit);
        if (config.offset !== undefined && !(typeof config.offset === "string" && config.offset.includes("{{"))) normalizeOffset(config.offset);
      }
    } catch (error) {
      if (error instanceof DataStoreValidationError) throw new BadRequestException(error.message);
      throw error;
    }
  }
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

function isVariableStep(type: string) {
  return [
    StepType.SetVariable,
    StepType.GetVariable,
    StepType.DeleteVariable,
    StepType.IncrementVariable,
    StepType.AppendVariable
  ].includes(type as StepType);
}

function containsExpression(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some(containsExpression);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsExpression);
  return false;
}

function selectorHasExpression(config: Record<string, unknown>) {
  return (typeof config.dataStoreId === "string" && config.dataStoreId.includes("{{")) || (typeof config.dataStoreName === "string" && config.dataStoreName.includes("{{"));
}

function normalizeRetryPolicy(raw: Record<string, unknown>) {
  const retry = isRecord(raw.retry) ? raw.retry : raw;
  return {
    retry: {
      maxAttempts: clampNumber(Number(retry.maxAttempts ?? 1), MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX),
      backoffMs: clampNumber(Number(retry.backoffMs ?? 1000), BACKOFF_MIN_MS, BACKOFF_MAX_MS),
      strategy: retry.strategy === "exponential" ? "exponential" : "fixed"
    }
  };
}

function normalizeTimeoutSeconds(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampNumber(Number(value), TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS);
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

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertNoSensitiveHttpHeaders(config: Record<string, unknown>) {
  const headers = config.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return;
  }
  const sensitive = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "api-key"]);
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (sensitive.has(lower) || lower.startsWith("proxy-")) {
      throw new BadRequestException("http_request credentials must use connectionId");
    }
  }
}
