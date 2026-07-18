import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { INTERNAL_EVENT_LIMITS, InternalEventDataByType, InternalEventSource, InternalEventSubject, InternalEventType, sanitizeInternalEventData } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { ApiMetricsService } from "../metrics/metrics.service";

export type InternalEventCausality = { rootEventId?: string | null; causationId?: string | null; depth?: number; correlationId?: string | null };
export type EmitInternalEventInput<T extends InternalEventType> = {
  organizationId: string; type: T; source: InternalEventSource; subject: InternalEventSubject;
  data: InternalEventDataByType[T]; causality?: InternalEventCausality;
};

@Injectable()
export class InternalEventEmitter {
  constructor(private readonly metrics?: ApiMetricsService) {}
  async emit<T extends InternalEventType>(tx: Prisma.TransactionClient, input: EmitInternalEventInput<T>) {
    const id = randomUUID();
    const occurredAt = new Date();
    const depth = input.causality?.rootEventId ? (input.causality.depth ?? 0) + 1 : 0;
    const rootEventId = input.causality?.rootEventId ?? id;
    const correlationId = input.causality?.correlationId ?? newTraceId();
    if (depth > configuredMaxDepth()) return this.suppress(tx, input, id, rootEventId, correlationId, depth, "depth");

    if (rootEventId === id) {
      await tx.internalEventChain.create({ data: { rootEventId, organizationId: input.organizationId, eventCount: 1 } });
    } else {
      const incremented = await tx.internalEventChain.updateMany({
        where: { rootEventId, organizationId: input.organizationId, eventCount: { lt: configuredMaxChainEvents() } },
        data: { eventCount: { increment: 1 } }
      });
      if (!incremented.count) return this.suppress(tx, input, id, rootEventId, correlationId, depth, "count");
    }
    const sanitized = sanitizeInternalEventData(input.data);
    const data = sanitized.omitted ? { ...sanitized.data, valueOmitted: true, valueSizeBytes: sanitized.originalBytes } : sanitized.data;
    const envelope = {
      id, schemaVersion: 1 as const, type: input.type, organizationId: input.organizationId,
      occurredAt: occurredAt.toISOString(), source: input.source, subject: input.subject,
      correlationId, rootEventId, causationId: input.causality?.causationId ?? null, depth, data
    };
    await tx.internalEvent.create({ data: {
      id, organizationId: input.organizationId, eventType: input.type, schemaVersion: 1,
      envelopeJson: json(envelope), occurredAt, rootEventId, causationId: envelope.causationId,
      correlationId, depth
    } });
    await tx.auditLog.create({ data: {
      organizationId: input.organizationId, actorUserId: null, action: "internal_event.emitted",
      resourceType: "InternalEvent", resourceId: id, correlationId,
      metadataJson: json({ eventType: input.type, depth, rootEventId, dataOmitted: sanitized.omitted })
    } });
    this.metrics?.internalEventsEmitted.inc({ event_type: input.type });
    return envelope;
  }

  private async suppress<T extends InternalEventType>(tx: Prisma.TransactionClient, input: EmitInternalEventInput<T>, id: string, rootEventId: string, correlationId: string, depth: number, reason: "depth" | "count") {
    await tx.auditLog.create({ data: {
      organizationId: input.organizationId, actorUserId: null, action: "internal_event.suppressed",
      resourceType: "InternalEvent", resourceId: id, correlationId,
      metadataJson: json({ eventType: input.type, depth, rootEventId, reason })
    } });
    this.metrics?.internalEventChainLimit.inc({ limit_type: reason });
    return null;
  }
}

function configuredMaxDepth() { return bounded(process.env.INTERNAL_EVENT_MAX_DEPTH, INTERNAL_EVENT_LIMITS.maxDepth, 1, 32); }
function configuredMaxChainEvents() { return bounded(process.env.INTERNAL_EVENT_MAX_CHAIN_EVENTS, INTERNAL_EVENT_LIMITS.maxChainEvents, 1, 1_000); }
function bounded(raw: string | undefined, fallback: number, min: number, max: number) { const value = Number(raw ?? fallback); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
