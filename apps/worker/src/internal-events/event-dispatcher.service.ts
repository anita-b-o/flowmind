import { InjectQueue } from "@nestjs/bullmq";
import { randomUUID } from "node:crypto";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { ExecutionMode, ExecutionStatus, isInternalEventType, matchesInternalEvent, normalizeEventTriggerFilters, type InternalEventEnvelope } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { WorkerIdentityService } from "../runtime/worker-identity.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "../queues/queue.constants";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { NotificationMaterializerService } from "../notifications/notification-materializer.service";

@Injectable()
export class EventDispatcherService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private currentRun?: Promise<void>;
  private destroyed = false;
  constructor(private readonly prisma: PrismaService, private readonly identity: WorkerIdentityService, private readonly shutdown: ShutdownStateService, @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue, private readonly metrics?: WorkerMetricsService, private readonly notifications?: NotificationMaterializerService) {}
  onModuleInit() { this.timer = setInterval(() => void this.dispatch(), numberEnv("INTERNAL_EVENT_POLL_INTERVAL_MS", 1_000, 100, 60_000)); this.timer.unref(); void this.dispatch(); }
  async onModuleDestroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    await this.currentRun;
  }
  isActive() { return Boolean(this.timer) && !this.destroyed && !this.shutdown.isShuttingDown(); }

  dispatch(): Promise<void> {
    if (this.currentRun) return this.currentRun;
    if (this.destroyed || this.shutdown.isShuttingDown()) return Promise.resolve();
    const run = this.runDispatch();
    this.currentRun = run.finally(() => { this.currentRun = undefined; });
    return this.currentRun;
  }

  private async runDispatch() {
    try {
      for (const row of await this.claim()) {
        try { await this.process(row.id); }
        catch (error) { if (!this.destroyed) await this.fail(row.id, error); }
      }
    }
    catch (error) { if (!this.destroyed) throw error; }
    finally { await this.recordBacklog().catch(() => undefined); }
  }

  private claim(): Promise<Array<{ id: string }>> {
    const batch = numberEnv("INTERNAL_EVENT_BATCH_SIZE", 50, 1, 200);
    const leaseMs = numberEnv("INTERNAL_EVENT_LEASE_MS", 30_000, 5_000, 300_000);
    return this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT id FROM internal_events
        WHERE status IN ('PENDING', 'PROCESSING')
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND (locked_until IS NULL OR locked_until < NOW())
        ORDER BY occurred_at ASC
        FOR UPDATE SKIP LOCKED LIMIT ${batch}
      )
      UPDATE internal_events e SET status = 'PROCESSING', locked_by = ${this.identity.id},
        locked_until = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), attempts = attempts + 1
      FROM candidates WHERE e.id = candidates.id RETURNING e.id
    `);
  }

  private async process(id: string) {
    const event = await this.prisma.internalEvent.findUniqueOrThrow({ where: { id } });
    const envelope = event.envelopeJson as unknown as InternalEventEnvelope;
    if (!isInternalEventType(envelope.type) || envelope.organizationId !== event.organizationId) throw permanent("invalid_envelope");
    await this.notifications?.materialize(event, envelope);
    if (!event.matchingCompletedAt) {
      const diagnostic = event.eventType === "EVENT_TRIGGER_FAILED" || event.eventType === "EVENT_CHAIN_DEPTH_EXCEEDED";
      const triggers = diagnostic ? [] : await this.prisma.trigger.findMany({ where: { organizationId: event.organizationId, type: "event", eventType: event.eventType, enabled: true, deletedAt: null } });
      const matches = triggers.filter((trigger) => {
        try { return matchesInternalEvent(envelope, normalizeEventTriggerFilters(envelope.type, storedConfig(trigger.configJson).filters)); } catch { return false; }
      });
      if (matches.length) this.metrics?.internalEventTriggerMatches.inc({ event_type: event.eventType }, matches.length);
      await this.prisma.$transaction(async (tx) => {
        if (matches.length) await tx.internalEventDelivery.createMany({ data: matches.map((trigger) => ({ organizationId: event.organizationId, internalEventId: event.id, triggerId: trigger.id })), skipDuplicates: true });
        await tx.internalEvent.update({ where: { id: event.id }, data: { matchingCompletedAt: new Date() } });
      });
    }
    const deliveries = await this.prisma.internalEventDelivery.findMany({ where: { internalEventId: id, organizationId: event.organizationId, status: "PENDING" }, include: { trigger: { include: { workflow: { include: { activeVersion: true } } } } } });
    for (const delivery of deliveries) await this.materialize(event, envelope, delivery);
    const pending = await this.prisma.internalEventDelivery.count({ where: { internalEventId: id, status: "PENDING" } });
    if (!pending) await this.prisma.$transaction(async (tx) => {
      await tx.internalEvent.update({ where: { id }, data: { status: "PROCESSED", processedAt: new Date(), lockedBy: null, lockedUntil: null, lastErrorCode: null } });
      await tx.auditLog.create({ data: { organizationId: event.organizationId, actorUserId: null, action: "internal_event.dispatched", resourceType: "InternalEvent", resourceId: id, correlationId: event.correlationId, metadataJson: json({ eventType: event.eventType, outcome: "processed" }) } });
    });
    this.metrics?.internalEventsDispatched.inc({ event_type: event.eventType, outcome: "processed" });
    this.metrics?.internalEventDispatchLatency.observe({ event_type: event.eventType }, Math.max(0, (Date.now() - event.occurredAt.getTime()) / 1000));
  }

  private async materialize(event: any, envelope: InternalEventEnvelope, delivery: any) {
    const workflow = delivery.trigger.workflow; const version = workflow.activeVersion;
    if (!delivery.trigger.enabled || delivery.trigger.deletedAt || workflow.status !== "ACTIVE" || !version || version.status !== "ACTIVE") {
      await this.prisma.internalEventDelivery.updateMany({ where: { id: delivery.id, status: "PENDING" }, data: { status: "SKIPPED", lastErrorCode: "inactive_target" } }); return;
    }
    let execution: { id: string; correlationId: string | null };
    try {
      execution = await this.prisma.$transaction(async (tx) => {
        const created = await tx.execution.create({ data: {
          organizationId: event.organizationId, workflowId: workflow.id, workflowVersionId: version.id,
          eventDeliveryId: delivery.id, eventRootId: event.rootEventId, eventCausationId: event.id, eventDepth: event.depth,
          correlationId: event.correlationId, status: ExecutionStatus.Queued, executionMode: ExecutionMode.Real,
          inputJson: json({ trigger: { event: envelope }, metadata: { triggerType: "event" } }),
          contextJson: json({ trigger: { event: envelope }, steps: {}, metadata: { triggerType: "event" } })
        }, select: { id: true, correlationId: true } });
        await tx.internalEventDelivery.update({ where: { id: delivery.id }, data: { status: "MATERIALIZED", executionId: created.id, materializedAt: new Date() } });
        await tx.trigger.update({ where: { id: delivery.triggerId }, data: { lastReceivedAt: new Date(), lastExecutionId: created.id } });
        await tx.auditLog.create({ data: { organizationId: event.organizationId, actorUserId: null, action: "event_trigger.execution.materialized", resourceType: "Execution", resourceId: created.id, correlationId: event.correlationId, metadataJson: json({ eventType: event.eventType, workflowId: workflow.id, triggerId: delivery.triggerId }) } });
        return created;
      });
      this.metrics?.internalEventExecutionsCreated.inc({ event_type: event.eventType });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      execution = await this.prisma.execution.findFirstOrThrow({ where: { eventDeliveryId: delivery.id, organizationId: event.organizationId }, select: { id: true, correlationId: true } });
      this.metrics?.internalEventDuplicates.inc({ stage: "execution" });
      await this.prisma.internalEventDelivery.updateMany({ where: { id: delivery.id, status: "PENDING" }, data: { status: "MATERIALIZED", executionId: execution.id, materializedAt: new Date() } });
    }
    await this.queue.add(EXECUTION_RUN_JOB, { organizationId: event.organizationId, executionId: execution.id, workflowId: workflow.id, workflowVersionId: version.id, requestId: `event-${event.id}`, correlationId: execution.correlationId ?? event.correlationId, enqueuedAt: new Date().toISOString(), executionMode: ExecutionMode.Real, origin: "event" }, { jobId: `execution-${execution.id}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false })
      .then(() => this.prisma.internalEventDelivery.update({ where: { id: delivery.id }, data: { enqueuedAt: new Date() } })).catch(() => undefined);
  }

  private async fail(id: string, error: unknown) {
    const row = await this.prisma.internalEvent.findUnique({ where: { id }, select: { attempts: true, organizationId: true, correlationId: true, eventType: true } }); if (!row) return;
    const code = errorCode(error); const dead = (error as any)?.permanent || row.attempts >= 10;
    this.metrics?.internalEventDispatchFailures.inc({ error_category: dispatchErrorCategory(error) });
    this.metrics?.internalEventsDispatched.inc({ event_type: row.eventType, outcome: dead ? "dead" : "retry" });
    const next = new Date(Date.now() + Math.min(300_000, 1_000 * 2 ** Math.max(0, row.attempts - 1)) + Math.floor(Math.random() * 500));
    await this.prisma.$transaction(async (tx) => {
      await tx.internalEvent.update({ where: { id }, data: { status: dead ? "DEAD" : "PENDING", deadLetteredAt: dead ? new Date() : null, nextAttemptAt: dead ? null : next, lockedBy: null, lockedUntil: null, lastErrorCode: code } });
      if (dead) await tx.auditLog.create({ data: { organizationId: row.organizationId, actorUserId: null, action: "internal_event.dead_lettered", resourceType: "InternalEvent", resourceId: id, correlationId: row.correlationId, metadataJson: json({ eventType: row.eventType, reason: code }) } });
      if (dead && row.eventType !== "EVENT_TRIGGER_FAILED") {
        const diagnosticId = randomUUID(); const occurredAt = new Date();
        const envelope = { id: diagnosticId, schemaVersion: 1, type: "EVENT_TRIGGER_FAILED", organizationId: row.organizationId, occurredAt: occurredAt.toISOString(), source: { type: "event_dispatcher" }, subject: { type: "internal_event", id }, correlationId: row.correlationId, rootEventId: diagnosticId, causationId: null, depth: 0, data: { internalEventId: id, eventType: row.eventType, errorCode: code } };
        await tx.internalEventChain.create({ data: { rootEventId: diagnosticId, organizationId: row.organizationId, eventCount: 1 } });
        await tx.internalEvent.create({ data: { id: diagnosticId, organizationId: row.organizationId, eventType: "EVENT_TRIGGER_FAILED", schemaVersion: 1, envelopeJson: json(envelope), occurredAt, rootEventId: diagnosticId, correlationId: row.correlationId, depth: 0 } });
      }
    });
  }
  private async recordBacklog() {
    if (!this.metrics) return;
    const [pending, dead, deliveries] = await this.prisma.$transaction([
      this.prisma.internalEvent.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      this.prisma.internalEvent.count({ where: { status: "DEAD" } }),
      this.prisma.internalEventDelivery.count({ where: { status: "PENDING" } })
    ]);
    this.metrics.internalEventBacklog.set({ state: "pending" }, pending); this.metrics.internalEventBacklog.set({ state: "dead" }, dead); this.metrics.internalEventBacklog.set({ state: "deliveries" }, deliveries);
  }
}
function storedConfig(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as any : {}; }
function numberEnv(name: string, fallback: number, min: number, max: number) { const value = Number(process.env[name] ?? fallback); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function permanent(code: string) { return Object.assign(new Error(code), { permanent: true, code }); }
function errorCode(error: unknown) { const raw = String((error as any)?.code ?? (error instanceof Error ? error.name : "unknown")).toLowerCase().replace(/[^a-z0-9_]/g, "_"); return raw.slice(0, 64) || "unknown"; }
function dispatchErrorCategory(error: unknown) { if ((error as any)?.permanent) return "permanent"; const code = String((error as any)?.code ?? ""); if (code.startsWith("P") || code.includes("REDIS")) return "infrastructure"; return "unknown"; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
