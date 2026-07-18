import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { INTERNAL_EVENT_LIMITS, InternalEventDataByType, InternalEventSource, InternalEventSubject, InternalEventType, sanitizeInternalEventData } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

export type InternalEventCausality = { rootEventId?: string | null; causationId?: string | null; depth?: number; correlationId?: string | null };

@Injectable()
export class InternalEventEmitter {
  constructor(private readonly metrics?: WorkerMetricsService) {}
  async emit<T extends InternalEventType>(tx: Prisma.TransactionClient, input: { organizationId: string; type: T; source: InternalEventSource; subject: InternalEventSubject; data: InternalEventDataByType[T]; causality?: InternalEventCausality }) {
    const id = randomUUID(); const occurredAt = new Date();
    const depth = input.causality?.rootEventId ? (input.causality.depth ?? 0) + 1 : 0;
    const rootEventId = input.causality?.rootEventId ?? id;
    const correlationId = input.causality?.correlationId ?? newTraceId();
    const maxDepth = bounded(process.env.INTERNAL_EVENT_MAX_DEPTH, INTERNAL_EVENT_LIMITS.maxDepth, 1, 32);
    const maxEvents = bounded(process.env.INTERNAL_EVENT_MAX_CHAIN_EVENTS, INTERNAL_EVENT_LIMITS.maxChainEvents, 1, 1_000);
    if (depth > maxDepth) return this.suppress(tx, input.organizationId, input.type, id, rootEventId, correlationId, depth, "depth");
    if (rootEventId === id) await tx.internalEventChain.create({ data: { rootEventId, organizationId: input.organizationId, eventCount: 1 } });
    else {
      const claimed = await tx.internalEventChain.updateMany({ where: { rootEventId, organizationId: input.organizationId, eventCount: { lt: maxEvents } }, data: { eventCount: { increment: 1 } } });
      if (!claimed.count) return this.suppress(tx, input.organizationId, input.type, id, rootEventId, correlationId, depth, "count");
    }
    const sanitized = sanitizeInternalEventData(input.data);
    const data = sanitized.omitted ? { ...sanitized.data, valueOmitted: true, valueSizeBytes: sanitized.originalBytes } : sanitized.data;
    const envelope = { id, schemaVersion: 1 as const, type: input.type, organizationId: input.organizationId, occurredAt: occurredAt.toISOString(), source: input.source, subject: input.subject, correlationId, rootEventId, causationId: input.causality?.causationId ?? null, depth, data };
    await tx.internalEvent.create({ data: { id, organizationId: input.organizationId, eventType: input.type, schemaVersion: 1, envelopeJson: json(envelope), occurredAt, rootEventId, causationId: envelope.causationId, correlationId, depth } });
    await tx.auditLog.create({ data: { organizationId: input.organizationId, actorUserId: null, action: "internal_event.emitted", resourceType: "InternalEvent", resourceId: id, correlationId, metadataJson: json({ eventType: input.type, depth, rootEventId, dataOmitted: sanitized.omitted }) } });
    this.metrics?.internalEventsEmitted.inc({ event_type: input.type });
    return envelope;
  }
  private async suppress(tx: Prisma.TransactionClient, organizationId: string, eventType: string, id: string, rootEventId: string, correlationId: string, depth: number, reason: string) {
    await tx.auditLog.create({ data: { organizationId, actorUserId: null, action: "internal_event.suppressed", resourceType: "InternalEvent", resourceId: id, correlationId, metadataJson: json({ eventType, depth, rootEventId, reason }) } });
    const diagnosticId = randomUUID(); const occurredAt = new Date();
    const envelope = { id: diagnosticId, schemaVersion: 1 as const, type: "EVENT_CHAIN_DEPTH_EXCEEDED" as const, organizationId, occurredAt: occurredAt.toISOString(), source: { type: "internal_event_guard" }, subject: { type: "internal_event_chain", id: rootEventId }, correlationId, rootEventId: diagnosticId, causationId: null, depth: 0, data: { suppressedEventType: eventType, rootEventId, depth, reason: reason as "depth" | "count" } };
    await tx.internalEventChain.create({ data: { rootEventId: diagnosticId, organizationId, eventCount: 1 } });
    await tx.internalEvent.create({ data: { id: diagnosticId, organizationId, eventType: envelope.type, schemaVersion: 1, envelopeJson: json(envelope), occurredAt, rootEventId: diagnosticId, correlationId, depth: 0 } });
    this.metrics?.internalEventChainLimit.inc({ limit_type: reason }); return null;
  }
}
function bounded(raw: string | undefined, fallback: number, min: number, max: number) { const value = Number(raw ?? fallback); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
