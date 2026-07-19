import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
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
  forEachRegions,
  tryCatchRegions,
  WorkflowStatus,
  WorkflowVariableValidationError,
  WorkflowVersionStatus
  ,normalizeExecuteWorkflowConfig
} from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowVersionDto } from "./dto/create-workflow-version.dto";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ExpressionsService } from "../expressions/expressions.service";
import { graphAvailableStepKeys, validateWorkflowGraph } from "./workflow-graph-validator";
import { workflowVersionDiff } from "./workflow-version-diff";
import { ListWorkflowVersionsQueryDto } from "./dto/list-workflow-versions-query.dto";
import { ApiMetricsService } from "../metrics/metrics.service";

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
    private readonly expressions?: ExpressionsService,
    private readonly metrics?: ApiMetricsService
  ) {}

  list(organizationId: string) {
    return this.prisma.workflow.findMany({
      where: { organizationId },
      include: { activeVersion: true },
      orderBy: { updatedAt: "desc" }
    });
  }

  async listInvocable(organizationId: string) {
    const workflows = await this.prisma.workflow.findMany({
      where: { organizationId, versions: { some: { activatedAt: { not: null }, status: { in: [WorkflowVersionStatus.Active, WorkflowVersionStatus.Archived] } } } },
      select: { id: true, name: true, activeVersion: { select: { id: true, versionNumber: true } }, versions: { where: { activatedAt: { not: null }, status: { in: [WorkflowVersionStatus.Active, WorkflowVersionStatus.Archived] } }, select: { id: true, versionNumber: true, status: true }, orderBy: { versionNumber: "desc" } } },
      orderBy: { name: "asc" }
    });
    return workflows.filter((workflow) => workflow.versions.length > 0);
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

  async listVersions(organizationId: string, workflowId: string, query: ListWorkflowVersionsQueryDto) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, select: { id: true, activeVersionId: true } });
    if (!workflow) throw new NotFoundException("Workflow not found");
    const limit = Math.min(query.limit ?? 20, 100);
    const cursor = decodeVersionCursor(query.cursor);
    const cursorWhere = cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : undefined;
    const rows = await this.prisma.workflowVersion.findMany({
      where: cursorWhere ? { AND: [{ workflowId, organizationId }, cursorWhere] } : { workflowId, organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      include: { createdBy: { select: { id: true, email: true, name: true } }, restoredFrom: { select: { id: true, versionNumber: true } } }
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items: items.map((row) => versionSummary(row, workflow.activeVersionId)), hasMore, nextCursor: hasMore ? encodeVersionCursor(items.at(-1)!) : null, pageSize: limit };
  }

  async versionDetail(organizationId: string, workflowId: string, versionId: string) {
    const version = await this.prisma.workflowVersion.findFirst({
      where: { id: versionId, workflowId, organizationId },
      include: { createdBy: { select: { id: true, email: true, name: true } }, restoredFrom: { select: { id: true, versionNumber: true } }, steps: { orderBy: { position: "asc" } }, workflow: { select: { activeVersionId: true } } }
    });
    if (!version) throw new NotFoundException("Workflow version not found");
    return { ...version, publishedAt: version.activatedAt, isActive: version.workflow.activeVersionId === version.id, triggerHistoryAvailable: version.materializedTriggerSnapshotJson !== null, workflow: undefined };
  }

  async diffVersions(organizationId: string, workflowId: string, versionId: string, otherVersionId: string) {
    const versions = await this.prisma.workflowVersion.findMany({ where: { organizationId, workflowId, id: { in: [versionId, otherVersionId] } } });
    if (versions.length !== (versionId === otherVersionId ? 1 : 2)) { this.metrics?.recordWorkflowVersionDiff("not_found", "SAFE"); throw new NotFoundException("Workflow version not found"); }
    const from = versions.find((version) => version.id === versionId)!;
    const to = versions.find((version) => version.id === otherVersionId)!;
    const result = workflowVersionDiff(from.definitionJson, to.definitionJson, { from: from.materializedTriggerSnapshotJson, to: to.materializedTriggerSnapshotJson });
    this.metrics?.recordWorkflowVersionDiff("success", result.summary.maxSeverity);
    return { fromVersion: versionIdentity(from), toVersion: versionIdentity(to), triggerHistoryAvailable: from.materializedTriggerSnapshotJson !== null && to.materializedTriggerSnapshotJson !== null, ...result };
  }

  async restorePreview(organizationId: string, workflowId: string, versionId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, include: { activeVersion: true } });
    const source = await this.prisma.workflowVersion.findFirst({ where: { id: versionId, workflowId, organizationId } });
    if (!workflow || !source) { this.metrics?.recordWorkflowVersionRestorePreview("not_found", false); throw new NotFoundException("Workflow version not found"); }
    const dependencies = await this.inspectDependencies(organizationId, workflowId, source.definitionJson);
    const diff = workflow.activeVersion ? workflowVersionDiff(workflow.activeVersion.definitionJson, source.definitionJson, { from: workflow.activeVersion.materializedTriggerSnapshotJson, to: source.materializedTriggerSnapshotJson }) : null;
    const publishable = dependencies.missingDependencies.length === 0 && dependencies.invalidReferences.length === 0;
    this.metrics?.recordWorkflowVersionRestorePreview("success", publishable);
    return { possible: true, publishable, sourceVersion: versionIdentity(source), currentActiveVersion: workflow.activeVersion ? versionIdentity(workflow.activeVersion) : null, diffSummary: diff?.summary ?? null, breakingWarnings: diff?.findings ?? [], ...dependencies, triggerHistoryAvailable: source.materializedTriggerSnapshotJson !== null };
  }

  async restoreVersion(organizationId: string, userId: string, workflowId: string, versionId: string) {
    try {
      const restored = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "workflows" WHERE "id" = ${workflowId} AND "organization_id" = ${organizationId} FOR UPDATE`);
        if (!locked.length) throw new NotFoundException("Workflow not found");
        const source = await tx.workflowVersion.findFirst({ where: { id: versionId, workflowId, organizationId }, include: { steps: { orderBy: { position: "asc" } } } });
        if (!source) throw new NotFoundException("Workflow version not found");
        this.validateStoredDefinition(source.definitionJson, false);
        assertMaterializedStepsConsistent(source.definitionJson, source.steps);
        const latest = await tx.workflowVersion.findFirst({ where: { workflowId, organizationId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } });
        const created = await tx.workflowVersion.create({
          data: {
            organizationId, workflowId, createdByUserId: userId, versionNumber: (latest?.versionNumber ?? 0) + 1,
            status: WorkflowVersionStatus.Draft, definitionJson: source.definitionJson as Prisma.InputJsonValue,
            restoredFromVersionId: source.id,
            materializedTriggerSnapshotJson: source.materializedTriggerSnapshotJson === null ? undefined : restoredTriggerSnapshot(source.materializedTriggerSnapshotJson),
            steps: { createMany: { data: source.steps.map((step) => ({ organizationId, key: step.key, name: step.name, type: step.type, position: step.position, configJson: step.configJson as Prisma.InputJsonValue, retryPolicyJson: step.retryPolicyJson === null ? undefined : step.retryPolicyJson as Prisma.InputJsonValue, timeoutSeconds: step.timeoutSeconds })) } }
          }, include: { steps: true, restoredFrom: { select: { id: true, versionNumber: true } } }
        });
        await this.auditLogs?.record({ organizationId, actorUserId: userId, action: "workflow.version_restored", resourceType: "WorkflowVersion", resourceId: created.id, metadata: { workflowId, sourceVersionId: source.id, newVersionId: created.id, sourceVersionNumber: source.versionNumber, newVersionNumber: created.versionNumber } }, tx);
        return created;
      });
      this.metrics?.recordWorkflowVersionRestore("success");
      return restored;
    } catch (error) {
      this.metrics?.recordWorkflowVersionRestore(error instanceof NotFoundException ? "not_found" : "failed");
      throw error;
    }
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

    const schemaVersion = dto.workflowDefinitionSchemaVersion ?? (dto.graph ? 2 : 1);
    if (schemaVersion === 2) {
      validateWorkflowGraph(dto.steps, dto.graph);
    }
    const workflowVariables = this.validateVariableMap(dto.workflowVariables, "workflow variables");
    const environmentVariables = this.validateVariableMap(dto.environmentVariables, "environment variables");
    this.validateStepConfigs(dto.steps);
    this.validateEntrypoint(dto.trigger, dto.steps, schemaVersion === 2 ? dto.graph : undefined);
    await this.validateSubworkflowReferences(organizationId, workflowId, dto.steps);
    await this.validateConnectionReferences(organizationId, [...dto.steps, dto.trigger]);
    await this.validateDataStoreReferences(organizationId, dto.steps, true);
    this.assertNoInlineCredentials([...dto.steps, dto.trigger]);
    this.validateExpressions(dto.steps, schemaVersion === 2 ? dto.graph : undefined);
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

    const triggerSnapshot = await this.captureMaterializedTriggerSnapshot(organizationId, workflowId);
    const version = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "workflows" WHERE "id" = ${workflowId} AND "organization_id" = ${organizationId} FOR UPDATE`);
      const latest = await tx.workflowVersion.findFirst({ where: { workflowId, organizationId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      return tx.workflowVersion.create({
        data: {
          organizationId,
          workflowId,
          createdByUserId,
          versionNumber,
          definitionJson: definition,
          materializedTriggerSnapshotJson: triggerSnapshot,
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
    });
    if (schemaVersion === 2) {
      await this.auditLogs?.record({
        organizationId,
        actorUserId: createdByUserId,
        action: "workflow.version.graph_created",
        resourceType: "WorkflowVersion",
        resourceId: version.id,
        metadata: { workflowId, versionNumber: version.versionNumber }
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
    if (version.status !== WorkflowVersionStatus.Draft || version.activatedAt) {
      throw new ConflictException("Only draft workflow versions can be published; restore a historical version to create a new draft");
    }
    const definition = isRecord(version.definitionJson) ? version.definitionJson : {};
    try {
      await this.validateStoredDefinitionForPublish(organizationId, workflowId, definition);
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

    return this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.updateMany({
        where: { workflowId, organizationId, status: WorkflowVersionStatus.Active },
        data: { status: WorkflowVersionStatus.Archived }
      });
      const published = await tx.workflowVersion.updateMany({
        where: { id: versionId, workflowId, organizationId, status: WorkflowVersionStatus.Draft, activatedAt: null },
        data: { status: WorkflowVersionStatus.Active, activatedAt: new Date() }
      });
      if (published.count !== 1) throw new ConflictException("Workflow version is no longer publishable");
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

  private validateStoredDefinition(value: unknown, includeExpressions: boolean) {
    const definition = isRecord(value) ? value : {};
    const trigger = isRecord(definition.trigger) ? definition.trigger as any : null;
    const steps = Array.isArray(definition.steps) ? definition.steps as any[] : [];
    if (!trigger || typeof trigger.key !== "string" || typeof trigger.type !== "string") throw new BadRequestException("Workflow version definition is invalid");
    const schemaVersion = definition.workflowDefinitionSchemaVersion ?? (definition.graph ? 2 : 1);
    if (schemaVersion === 2) validateWorkflowGraph(steps, definition.graph as Record<string, unknown>);
    this.validateVariableMap(definition.workflowVariables, "workflow variables");
    this.validateVariableMap(definition.environmentVariables, "environment variables");
    this.validateStepConfigs(steps);
    this.validateEntrypoint(trigger, steps, schemaVersion === 2 ? definition.graph as Record<string, unknown> : undefined);
    if (includeExpressions) this.validateExpressions(steps, schemaVersion === 2 ? definition.graph as Record<string, unknown> : undefined);
    return { definition, trigger, steps, schemaVersion };
  }

  private async validateStoredDefinitionForPublish(organizationId: string, workflowId: string, value: unknown) {
    const parsed = this.validateStoredDefinition(value, true);
    await this.validateSubworkflowReferences(organizationId, workflowId, parsed.steps);
    await this.validateConnectionReferences(organizationId, [...parsed.steps, parsed.trigger]);
    await this.validateDataStoreReferences(organizationId, parsed.steps, true);
    this.assertNoInlineCredentials([...parsed.steps, parsed.trigger]);
  }

  private async inspectDependencies(organizationId: string, workflowId: string, value: unknown) {
    const missingDependencies: Array<{ type: string; id?: string; name?: string; stepKey?: string }> = [];
    const invalidReferences: Array<{ type: string; reason: string; stepKey?: string }> = [];
    const unverifiableReferences: Array<{ type: string; reason: string; stepKey?: string }> = [];
    let parsed: ReturnType<WorkflowsService["validateStoredDefinition"]>;
    try { parsed = this.validateStoredDefinition(value, true); } catch (error) { return { missingDependencies, invalidReferences: [{ type: "definition", reason: error instanceof Error ? error.message : "Invalid definition" }], unverifiableReferences }; }
    for (const step of parsed.steps) {
      const config = isRecord(step.config) ? step.config : {};
      const connectionId = stringValue(config.connectionId);
      if (connectionId) {
        const connection = await this.prisma.connection.findFirst({ where: { id: connectionId, organizationId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
        if (!connection) missingDependencies.push({ type: "connection", id: connectionId, stepKey: step.key });
      }
      if (isDataStoreStep(step.type)) {
        if (selectorHasExpression(config)) unverifiableReferences.push({ type: "data_store", reason: "Dynamic selector cannot be verified before execution", stepKey: step.key });
        else {
          const store = await this.prisma.dataStore.findFirst({ where: { organizationId, deletedAt: null, ...(stringValue(config.dataStoreId) ? { id: stringValue(config.dataStoreId) } : { name: stringValue(config.dataStoreName) }) }, select: { id: true, name: true } });
          if (!store) missingDependencies.push({ type: "data_store", id: stringValue(config.dataStoreId), name: stringValue(config.dataStoreName), stepKey: step.key });
        }
      }
      if (step.type === StepType.ExecuteWorkflow) {
        try { await this.validateSubworkflowReferences(organizationId, workflowId, [step]); } catch (error) { missingDependencies.push({ type: "subworkflow", id: stringValue(config.workflowId), stepKey: step.key }); }
      }
    }
    try { this.assertNoInlineCredentials([...parsed.steps, parsed.trigger]); } catch (error) { invalidReferences.push({ type: "inline_credentials", reason: error instanceof Error ? error.message : "Inline credentials are forbidden" }); }
    return { missingDependencies, invalidReferences, unverifiableReferences };
  }

  private async validateDataStoreReferences(organizationId: string, steps: Array<{ key?: string; type: string; config: Record<string, unknown> }>, failDynamic: boolean) {
    for (const step of steps.filter((entry) => isDataStoreStep(entry.type))) {
      if (selectorHasExpression(step.config)) { if (failDynamic) continue; else continue; }
      const id = stringValue(step.config.dataStoreId); const name = stringValue(step.config.dataStoreName);
      const found = await this.prisma.dataStore.findFirst({ where: { organizationId, deletedAt: null, ...(id ? { id } : { name }) }, select: { id: true } });
      if (!found) throw new BadRequestException("Workflow step references an unavailable Data Store");
    }
  }

  private assertNoInlineCredentials(steps: Array<{ type: string; config: Record<string, unknown> }>) {
    for (const step of steps) {
      const keys = Object.keys(step.config ?? {}).map((key) => key.toLowerCase().replace(/[-_]/g, ""));
      if (keys.some((key) => ["password", "smtppassword", "authorization", "token", "apikey", "secret", "secretvalue", "connectionstring"].includes(key))) {
        throw new BadRequestException("Workflow definitions cannot contain inline credentials");
      }
      if (step.type === "http_request") assertNoSensitiveHttpHeaders(step.config);
    }
  }

  private async captureMaterializedTriggerSnapshot(organizationId: string, workflowId: string): Promise<Prisma.InputJsonValue> {
    const triggers = await this.prisma.trigger.findMany({ where: { organizationId, workflowId, deletedAt: null }, orderBy: { id: "asc" }, select: { id: true, type: true, eventType: true, httpMethod: true, configJson: true, enabled: true, paused: true, cron: true, timezone: true, executionPolicy: true } });
    return toPrismaJson({ capturedAtVersionCreation: true, materialized: true, triggers: triggers.map((trigger) => ({ id: trigger.id, type: trigger.type, eventType: trigger.eventType, httpMethod: trigger.httpMethod, enabled: trigger.enabled, paused: trigger.paused, cron: trigger.cron, timezone: trigger.timezone, executionPolicy: trigger.executionPolicy, config: safeTriggerConfig(trigger.configJson) })) });
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

  private validateEntrypoint(trigger: { type: string }, steps: Array<{ key: string; type: string }>, graph?: Record<string, unknown>) {
    if (![StepType.WebhookTrigger, StepType.SubworkflowTrigger].includes(trigger.type as StepType)) throw new BadRequestException("Workflow trigger type is invalid");
    const returns = steps.filter((step) => step.type === StepType.ReturnWorkflowOutput);
    if (trigger.type !== StepType.SubworkflowTrigger && returns.length) throw new BadRequestException("RETURN_WORKFLOW_OUTPUT is only valid for subworkflow entrypoints");
    if (graph) {
      const controlled = [...forEachRegions(steps as any, graph).flatMap((region) => [...region.bodyStepKeys]), ...tryCatchRegions(steps as any, graph).flatMap((region) => [...region.bodyStepKeys, ...region.catchStepKeys, ...region.finallyStepKeys])];
      if (returns.some((step) => controlled.includes(step.key))) throw new BadRequestException("RETURN_WORKFLOW_OUTPUT cannot be used inside FOR_EACH or TRY_CATCH regions");
    }
  }

  private async validateSubworkflowReferences(organizationId: string, sourceWorkflowId: string, steps: Array<{ type: string; config: Record<string, unknown> }>) {
    for (const step of steps.filter((entry) => entry.type === StepType.ExecuteWorkflow)) {
      let config;
      try { config = normalizeExecuteWorkflowConfig(step.config); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Invalid EXECUTE_WORKFLOW config"); }
      if (config.workflowId === sourceWorkflowId) throw new BadRequestException("A workflow cannot execute itself");
      const target = await this.prisma.workflow.findFirst({ where: { id: config.workflowId, organizationId }, select: { id: true, activeVersionId: true } });
      if (!target) throw new BadRequestException("EXECUTE_WORKFLOW references an unavailable workflow");
      const versionId = config.versionPolicy === "PINNED_VERSION" ? config.workflowVersionId : target.activeVersionId;
      if (!versionId) throw new BadRequestException("EXECUTE_WORKFLOW target has no published version");
      const version = await this.prisma.workflowVersion.findFirst({ where: { id: versionId, workflowId: target.id, organizationId, activatedAt: { not: null }, status: { in: [WorkflowVersionStatus.Active, WorkflowVersionStatus.Archived] } }, select: { id: true, definitionJson: true } });
      if (!version) throw new BadRequestException("EXECUTE_WORKFLOW version is not published");
      await this.assertNoPublishedCycle(organizationId, sourceWorkflowId, target.id, new Set([sourceWorkflowId]));
    }
  }

  private async assertNoPublishedCycle(organizationId: string, sourceWorkflowId: string, workflowId: string, ancestry: Set<string>): Promise<void> {
    if (ancestry.has(workflowId)) throw new BadRequestException("Subworkflow dependency cycle detected");
    const nextAncestry = new Set(ancestry).add(workflowId);
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, include: { activeVersion: true } });
    const definition = isRecord(workflow?.activeVersion?.definitionJson) ? workflow!.activeVersion!.definitionJson as Record<string, unknown> : {};
    const steps = Array.isArray(definition.steps) ? definition.steps as Array<{ type: string; config: Record<string, unknown> }> : [];
    for (const step of steps.filter((entry) => entry.type === StepType.ExecuteWorkflow)) {
      const targetId = stringValue(step.config?.workflowId);
      if (targetId) await this.assertNoPublishedCycle(organizationId, sourceWorkflowId, targetId, nextAncestry);
    }
  }

  private validateExpressions(steps: Array<{ key: string; type: string; config: Record<string, unknown> }>, graph?: Record<string, unknown>) {
    const loopRegions = graph ? forEachRegions(steps, graph) : [];
    const tryRegions = graph ? tryCatchRegions(steps, graph) : [];
    const previous: string[] = [];
    for (const step of steps) {
      let available = graph ? graphAvailableStepKeys(step.key, steps, graph) : previous;
      for (const region of loopRegions) {
        if (!region.bodyStepKeys.has(step.key)) available = available.filter((key) => !region.bodyStepKeys.has(key));
      }
      for (const region of tryRegions) {
        if (!region.catchStepKeys.has(step.key)) available = available.filter((key) => !region.catchStepKeys.has(key));
        if (!region.finallyStepKeys.has(step.key)) available = available.filter((key) => !region.finallyStepKeys.has(key));
      }
      const inLoopBody = loopRegions.some((region) => region.bodyStepKeys.has(step.key));
      const inCatch = tryRegions.some((region) => region.catchStepKeys.has(step.key));
      const locals: Array<"item" | "index" | "error"> = [];
      if (step.type === StepType.Transform || inLoopBody) locals.push("item", "index");
      if (inCatch) locals.push("error");
      this.expressions?.validateValue(step.config, available, step.key, locals.length ? locals : undefined);
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
      if (step.type === StepType.ExecuteWorkflow) {
        try { normalizeExecuteWorkflowConfig(step.config); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Invalid EXECUTE_WORKFLOW config"); }
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

function versionSummary(version: any, activeVersionId: string | null) {
  return { id: version.id, versionNumber: version.versionNumber, status: version.status, createdAt: version.createdAt, publishedAt: version.activatedAt, activatedAt: version.activatedAt, createdBy: version.createdBy, isActive: version.id === activeVersionId, restoredFromVersion: version.restoredFrom, triggerHistoryAvailable: version.materializedTriggerSnapshotJson !== null };
}

function versionIdentity(version: any) { return { id: version.id, versionNumber: version.versionNumber, status: version.status, createdAt: version.createdAt, publishedAt: version.activatedAt }; }

function encodeVersionCursor(version: { createdAt: Date; id: string }) { return Buffer.from(JSON.stringify({ createdAt: version.createdAt.toISOString(), id: version.id })).toString("base64url"); }
function decodeVersionCursor(value?: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error("invalid");
    return { id: String(parsed.id), createdAt };
  } catch { throw new BadRequestException("Invalid version cursor"); }
}

function safeTriggerConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeTriggerConfig);
  if (!value || typeof value !== "object") return value;
  const blocked = new Set(["authorization", "cookie", "password", "token", "tokenhash", "tokenpreview", "secret", "secretvalue", "encryptedsecret", "encryptedvalue", "ciphertext", "authtag", "iv", "apikey", "xapikey", "credentials", "connectionstring"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !blocked.has(key.toLowerCase().replace(/[-_]/g, ""))).map(([key, entry]) => [key, safeTriggerConfig(entry)]));
}

function restoredTriggerSnapshot(value: unknown): Prisma.InputJsonValue {
  const snapshot = isRecord(value) ? value : {};
  return toPrismaJson({ ...snapshot, materialized: false, restoredHistoricalSnapshot: true });
}

function assertMaterializedStepsConsistent(definitionValue: unknown, steps: Array<{ key: string; type: string; configJson: unknown }>) {
  const definition = isRecord(definitionValue) ? definitionValue : {};
  const logical = [definition.trigger, ...(Array.isArray(definition.steps) ? definition.steps : [])].filter(isRecord) as Array<Record<string, unknown>>;
  if (logical.length !== steps.length) throw new ConflictException("Workflow version snapshot is inconsistent and cannot be restored safely");
  for (const row of logical) {
    const materialized = steps.find((step) => step.key === row.key);
    if (!materialized || materialized.type !== row.type || JSON.stringify(materialized.configJson) !== JSON.stringify(row.config ?? {})) throw new ConflictException("Workflow version snapshot is inconsistent and cannot be restored safely");
  }
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
