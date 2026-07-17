import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ExecutionMode, ExecutionStatus } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";
import { sanitizePublic } from "../common/public-sanitizer";
import { validateWorkflowGraph } from "../workflows/workflow-graph-validator";
import { CreateScheduledTriggerDto, PreviewScheduledTriggerDto, UpdateScheduledTriggerDto } from "./dto/scheduled-trigger.dto";
import { ScheduledCronService } from "./scheduled-cron.service";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_EXECUTION_STATUSES = ["PENDING", "QUEUED", "RUNNING", "RETRYING"] as const;

@Injectable()
export class ScheduledTriggersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly cron: ScheduledCronService,
    private readonly auditLogs?: AuditLogsService,
    private readonly metrics?: ApiMetricsService
  ) {}

  async onModuleInit() {
    await this.recoverSchedulers();
  }

  async create(organizationId: string, userId: string, workflowId: string, dto: CreateScheduledTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const schedule = this.cron.validate(dto.cron, dto.timezone);
    const trigger = await this.prisma.trigger.create({
      data: {
        organizationId,
        workflowId,
        type: "scheduled",
        tokenHash: null,
        tokenPreview: null,
        configJson: toJson({ metadata: sanitizePublic(dto.metadata ?? {}) }),
        cron: schedule.cron,
        timezone: schedule.timezone,
        enabled: dto.enabled ?? true,
        paused: dto.paused ?? false,
        executionPolicy: dto.executionPolicy ?? "skip_if_running",
        nextRunAt: schedule.nextRunAt
      }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "scheduled.trigger.created",
      resourceType: "Trigger",
      resourceId: trigger.id,
      metadata: { workflowId, cron: schedule.cron, timezone: schedule.timezone }
    });
    await this.syncScheduler(trigger);
    return this.summary(trigger);
  }

  async list(organizationId: string, workflowId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const triggers = await this.prisma.trigger.findMany({
      where: { organizationId, workflowId, type: "scheduled", deletedAt: null },
      orderBy: { createdAt: "desc" }
    });
    return triggers.map((trigger) => this.summary(trigger));
  }

  async get(organizationId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const trigger = await this.findScheduled(organizationId, workflowId, triggerId);
    return this.summary(trigger);
  }

  async update(organizationId: string, userId: string, workflowId: string, triggerId: string, dto: UpdateScheduledTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const current = await this.findScheduled(organizationId, workflowId, triggerId);
    const nextCron = dto.cron ?? current.cron;
    const nextTimezone = dto.timezone ?? current.timezone;
    if (!nextCron || !nextTimezone) {
      throw new BadRequestException("Cron and timezone are required");
    }
    const schedule = this.cron.validate(nextCron, nextTimezone);
    const trigger = await this.prisma.trigger.update({
      where: { id: triggerId },
      data: {
        cron: schedule.cron,
        timezone: schedule.timezone,
        executionPolicy: dto.executionPolicy ?? current.executionPolicy,
        configJson: toJson({ ...safeConfig(current.configJson), metadata: sanitizePublic(dto.metadata ?? safeConfig(current.configJson).metadata ?? {}) }),
        nextRunAt: schedule.nextRunAt
      }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "scheduled.trigger.updated",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, cron: schedule.cron, timezone: schedule.timezone }
    });
    await this.syncScheduler(trigger, userId);
    return this.summary(trigger);
  }

  async setEnabled(organizationId: string, userId: string, workflowId: string, triggerId: string, enabled: boolean) {
    await this.assertWorkflow(organizationId, workflowId);
    const current = await this.findScheduled(organizationId, workflowId, triggerId);
    const nextRunAt = current.cron && current.timezone ? this.cron.validate(current.cron, current.timezone).nextRunAt : current.nextRunAt;
    const trigger = await this.prisma.trigger.update({
      where: { id: triggerId },
      data: { enabled, nextRunAt }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: enabled ? "scheduled.trigger.enabled" : "scheduled.trigger.disabled",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId }
    });
    await this.syncScheduler(trigger, userId);
    return this.summary(trigger);
  }

  async setPaused(organizationId: string, userId: string, workflowId: string, triggerId: string, paused: boolean) {
    await this.assertWorkflow(organizationId, workflowId);
    const current = await this.findScheduled(organizationId, workflowId, triggerId);
    const nextRunAt = current.cron && current.timezone ? this.cron.validate(current.cron, current.timezone).nextRunAt : current.nextRunAt;
    const trigger = await this.prisma.trigger.update({
      where: { id: triggerId },
      data: { paused, nextRunAt }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: paused ? "scheduled.trigger.paused" : "scheduled.trigger.resumed",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId }
    });
    await this.syncScheduler(trigger, userId);
    return this.summary(trigger);
  }

  async delete(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    await this.findScheduled(organizationId, workflowId, triggerId);
    const trigger = await this.prisma.trigger.update({
      where: { id: triggerId },
      data: { enabled: false, paused: true, deletedAt: new Date(), nextRunAt: null }
    });
    await this.queueService.removeScheduledTriggerScheduler(triggerId);
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "scheduled.trigger.deleted",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId }
    });
    return { deleted: true };
  }

  preview(dto: PreviewScheduledTriggerDto) {
    const schedule = this.cron.validate(dto.cron, dto.timezone);
    return {
      cron: schedule.cron,
      timezone: schedule.timezone,
      nextRuns: this.cron.nextRuns(schedule.cron, schedule.timezone, 5).map((run) => run.toISOString())
    };
  }

  async runDue(triggerId: string, organizationId: string) {
    const started = Date.now();
    const trigger = await this.prisma.trigger.findFirst({
      where: { id: triggerId, organizationId, type: "scheduled", deletedAt: null },
      include: { workflow: { include: { activeVersion: true } } }
    });
    if (!trigger) return { skipped: true, reason: "not_found" };
    if (!trigger.enabled || trigger.paused || !trigger.cron || !trigger.timezone || !trigger.nextRunAt) {
      await this.queueService.removeScheduledTriggerScheduler(trigger.id);
      return { skipped: true, reason: "inactive" };
    }

    const now = new Date();
    if (trigger.nextRunAt > now) {
      return { skipped: true, reason: "not_due" };
    }

    const scheduledFor = trigger.nextRunAt;
    const nextRunAt = this.cron.nextAfter(trigger.cron, trigger.timezone, scheduledFor);
    const idempotencyKey = scheduledFor.toISOString();
    const scope = `scheduled-trigger:${trigger.id}`;
    const correlationId = newTraceId();

    if (trigger.workflow.status !== "ACTIVE" || !trigger.workflow.activeVersion || trigger.workflow.activeVersion.status !== "ACTIVE") {
      await this.advanceMissed(trigger, scheduledFor, nextRunAt, "inactive_workflow");
      return { skipped: true, reason: "inactive_workflow" };
    }
    validateVersionDefinition(trigger.workflow.activeVersion.definitionJson);

    if (trigger.executionPolicy === "skip_if_running") {
      const active = await this.prisma.execution.findFirst({
        where: {
          organizationId,
          scheduledTriggerId: trigger.id,
          status: { in: ACTIVE_EXECUTION_STATUSES as any }
        },
        select: { id: true }
      });
      if (active) {
        await this.advanceMissed(trigger, scheduledFor, nextRunAt, "active_execution");
        return { skipped: true, reason: "active_execution" };
      }
    }

    const created = await this.prisma
      .$transaction(async (tx) => {
        await tx.idempotencyKey.create({
          data: {
            organizationId,
            scope,
            key: idempotencyKey,
            requestHash: sha256(`${trigger.id}:${idempotencyKey}`),
            status: "PROCESSING",
            lockedUntil: new Date(Date.now() + 60_000),
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
          }
        });
        const triggerContext = {
          type: "scheduled",
          triggerId: trigger.id,
          scheduledFor: scheduledFor.toISOString(),
          firedAt: now.toISOString(),
          cron: trigger.cron,
          timezone: trigger.timezone
        };
        const execution = await tx.execution.create({
          data: {
            organizationId,
            workflowId: trigger.workflowId,
            workflowVersionId: trigger.workflow.activeVersion!.id,
            scheduledTriggerId: trigger.id,
            scheduledFor,
            correlationId,
            status: ExecutionStatus.Queued,
            executionMode: ExecutionMode.Real,
            inputJson: toJson({ trigger: triggerContext, metadata: safeConfig(trigger.configJson).metadata ?? {} }),
            contextJson: toJson({ trigger: triggerContext, steps: {}, metadata: safeConfig(trigger.configJson).metadata ?? {} })
          }
        });
        await tx.trigger.updateMany({
          where: { id: trigger.id, nextRunAt: scheduledFor, deletedAt: null },
          data: { lastRunAt: now, lastReceivedAt: now, lastExecutionId: execution.id, nextRunAt }
        });
        const response = { accepted: true, executionId: execution.id, correlationId };
        await tx.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId, scope, key: idempotencyKey } },
          data: { status: "ENQUEUED", responseJson: toJson(response), lockedUntil: null }
        });
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId: null,
            action: "scheduled.execution.created",
            resourceType: "Execution",
            resourceId: execution.id,
            correlationId,
            metadata: { workflowId: trigger.workflowId, workflowVersionId: trigger.workflow.activeVersion!.id, triggerId: trigger.id, scheduledFor: scheduledFor.toISOString() }
          },
          tx
        );
        return execution;
      })
      .catch((error) => {
        if ((error as any)?.code === "P2002") {
          this.metrics?.recordScheduledDuplicatePrevented();
          throw new ConflictException("Scheduled execution already exists for this run");
        }
        throw error;
      });

    try {
      await this.queueService.enqueueExecution({
        organizationId,
        executionId: created.id,
        workflowId: trigger.workflowId,
        workflowVersionId: trigger.workflow.activeVersion.id,
        requestId: `scheduled-${created.id}`,
        correlationId,
        enqueuedAt: new Date().toISOString(),
        executionMode: ExecutionMode.Real
      });
      this.metrics?.recordScheduledExecutionCreated();
      this.metrics?.recordScheduledLatency((Date.now() - scheduledFor.getTime()) / 1000);
      this.metrics?.recordScheduledSchedulerLatency((Date.now() - started) / 1000);
      return { executionId: created.id };
    } catch (error) {
      this.metrics?.recordEnqueueFailure("scheduled", classifyError(error));
      await this.prisma.execution.update({
        where: { id: created.id },
        data: { status: ExecutionStatus.Queued, errorJson: toJson({ message: "Failed to enqueue scheduled execution; recoverable by execution reconciler" }) }
      });
      throw new ServiceUnavailableException({
        message: "Scheduled execution was created but could not be enqueued immediately. It is recoverable by the reconciler.",
        recoverable: true,
        executionId: created.id
      });
    }
  }

  async recoverSchedulers() {
    await this.recordTriggerStateMetrics();
    const triggers = await this.prisma.trigger.findMany({
      where: { type: "scheduled", enabled: true, paused: false, deletedAt: null, cron: { not: null }, timezone: { not: null } }
    });
    for (const trigger of triggers) {
      await this.syncScheduler(trigger);
      if (trigger.nextRunAt && trigger.nextRunAt <= new Date()) {
        this.metrics?.recordScheduledRecovered();
        await this.runDue(trigger.id, trigger.organizationId).catch(() => undefined);
      }
    }
  }

  private async recordTriggerStateMetrics() {
    if (!this.metrics) return;
    const [enabled, paused, disabled] = await this.prisma.$transaction([
      this.prisma.trigger.count({ where: { type: "scheduled", enabled: true, paused: false, deletedAt: null } }),
      this.prisma.trigger.count({ where: { type: "scheduled", paused: true, deletedAt: null } }),
      this.prisma.trigger.count({ where: { type: "scheduled", enabled: false, deletedAt: null } })
    ]);
    this.metrics.recordScheduledTriggers("enabled", enabled);
    this.metrics.recordScheduledTriggers("paused", paused);
    this.metrics.recordScheduledTriggers("disabled", disabled);
  }

  private async syncScheduler(
    trigger: { id: string; organizationId: string; workflowId: string; enabled: boolean; paused: boolean; deletedAt: Date | null; cron: string | null; timezone: string | null },
    actorUserId?: string
  ) {
    if (!trigger.enabled || trigger.paused || trigger.deletedAt || !trigger.cron || !trigger.timezone) {
      await this.queueService.removeScheduledTriggerScheduler(trigger.id);
      return;
    }
    const schedule = this.cron.validate(trigger.cron, trigger.timezone);
    await this.queueService.upsertScheduledTriggerScheduler({
      triggerId: trigger.id,
      organizationId: trigger.organizationId,
      cronPattern: schedule.bullPattern,
      timezone: schedule.timezone
    });
    await this.auditLogs?.record({
      organizationId: trigger.organizationId,
      actorUserId: actorUserId ?? null,
      action: "scheduled.trigger.rescheduled",
      resourceType: "Trigger",
      resourceId: trigger.id,
      metadata: { workflowId: trigger.workflowId, cron: schedule.cron, timezone: schedule.timezone }
    });
  }

  private async advanceMissed(trigger: { id: string; organizationId: string; workflowId: string }, scheduledFor: Date, nextRunAt: Date, reason: string) {
    await this.prisma.trigger.updateMany({
      where: { id: trigger.id, nextRunAt: scheduledFor },
      data: { nextRunAt }
    });
    this.metrics?.recordScheduledMissed(reason === "active_execution" ? "active_execution" : "inactive_workflow");
    await this.auditLogs?.record({
      organizationId: trigger.organizationId,
      actorUserId: null,
      action: "scheduled.trigger.rescheduled",
      resourceType: "Trigger",
      resourceId: trigger.id,
      metadata: { workflowId: trigger.workflowId, skippedScheduledFor: scheduledFor.toISOString(), nextRunAt: nextRunAt.toISOString(), reason }
    });
  }

  private async findScheduled(organizationId: string, workflowId: string, triggerId: string) {
    const trigger = await this.prisma.trigger.findFirst({ where: { id: triggerId, organizationId, workflowId, type: "scheduled", deletedAt: null } });
    if (!trigger) throw new NotFoundException("Scheduled trigger not found");
    return trigger;
  }

  private async assertWorkflow(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) throw new NotFoundException("Workflow not found");
    return workflow;
  }

  private summary(trigger: {
    id: string;
    type: string;
    workflowId: string;
    enabled: boolean;
    paused: boolean;
    cron: string | null;
    timezone: string | null;
    executionPolicy: string;
    configJson: unknown;
    createdAt: Date;
    updatedAt: Date;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    lastExecutionId: string | null;
  }) {
    return {
      id: trigger.id,
      type: trigger.type,
      workflowId: trigger.workflowId,
      enabled: trigger.enabled,
      paused: trigger.paused,
      cron: trigger.cron,
      timezone: trigger.timezone,
      executionPolicy: trigger.executionPolicy,
      metadata: safeConfig(trigger.configJson).metadata ?? {},
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
      lastRunAt: trigger.lastRunAt,
      nextRunAt: trigger.nextRunAt,
      lastExecutionId: trigger.lastExecutionId
    };
  }
}

function validateVersionDefinition(value: unknown) {
  const definition = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (definition.workflowDefinitionSchemaVersion === 2) {
    validateWorkflowGraph((definition.steps as any[]) ?? [], definition.graph as Record<string, unknown>);
  }
}

function safeConfig(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
