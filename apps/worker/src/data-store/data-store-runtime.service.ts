import { Injectable } from "@nestjs/common";
import {
  assertDataStoreKey,
  assertDataStoreMetadata,
  assertDataStoreSelector,
  assertDataStoreValue,
  dataStorePreview,
  DATA_STORE_LIMITS,
  DataStoreSelector,
  DataStoreValidationError,
  mergeJsonObjects,
  normalizeListLimit,
  normalizeOffset,
  normalizeSortBy,
  normalizeSortDirection,
  normalizeUpsertMode,
  ttlSecondsToExpiresAt
} from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NonRetryableStepError } from "../engine/step-errors";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { InternalEventEmitter } from "../internal-events/internal-event-emitter.service";

export type DataStoreRuntimeContext = {
  organizationId: string;
  executionId?: string;
  stepExecutionId?: string;
  correlationId?: string | null;
  eventRootId?: string | null;
  eventCausationId?: string | null;
  eventDepth?: number;
};

@Injectable()
export class DataStoreRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics?: WorkerMetricsService,
    private readonly events?: InternalEventEmitter
  ) {}

  async get(context: DataStoreRuntimeContext, input: DataStoreSelector & { key: unknown; failIfMissing?: unknown }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const key = safe(() => assertDataStoreKey(input.key));
    const record = await this.prisma.dataStoreRecord.findFirst({ where: { organizationId: context.organizationId, dataStoreId: store.id, key, deletedAt: null } });
    if (!record) {
      if (input.failIfMissing === true) throw new NonRetryableStepError("Data Store record is missing");
      this.record("get", "miss", started);
      return { found: false, key, value: null, metadata: null, version: null, timestamps: null };
    }
    if (isExpired(record)) {
      await this.markExpired(record, context);
      if (input.failIfMissing === true) throw new NonRetryableStepError("Data Store record is missing");
      this.record("get", "ttl_expired", started);
      return { found: false, key, value: null, metadata: null, version: null, timestamps: null, expired: true };
    }
    this.record("get", "hit", started);
    return { found: true, key, value: record.valueJson, metadata: record.metadataJson, version: record.version, timestamps: timestamps(record) };
    } catch (error) {
      this.record("get", "error", started, errorCategory(error));
      throw error;
    }
  }

  async exists(context: DataStoreRuntimeContext, input: DataStoreSelector & { key: unknown }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const key = safe(() => assertDataStoreKey(input.key));
    const record = await this.prisma.dataStoreRecord.findFirst({
      where: { organizationId: context.organizationId, dataStoreId: store.id, key, deletedAt: null },
      select: { id: true, organizationId: true, dataStoreId: true, key: true, version: true, expiresAt: true }
    });
    if (!record) {
      this.record("exists", "miss", started);
      return { exists: false };
    }
    if (isExpired(record)) {
      await this.markExpired(record, context);
      this.record("exists", "ttl_expired", started);
      return { exists: false };
    }
    this.record("exists", "hit", started);
    return { exists: true };
    } catch (error) {
      this.record("exists", "error", started, errorCategory(error));
      throw error;
    }
  }

  async count(context: DataStoreRuntimeContext, input: DataStoreSelector & { keyPrefix?: unknown }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const now = new Date();
    const count = await this.prisma.dataStoreRecord.count({
      where: {
        organizationId: context.organizationId,
        dataStoreId: store.id,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(typeof input.keyPrefix === "string" && input.keyPrefix ? { key: { startsWith: input.keyPrefix } } : {})
      }
    });
    this.record("count", "success", started);
    return { count };
    } catch (error) {
      this.record("count", "error", started, errorCategory(error));
      throw error;
    }
  }

  async list(context: DataStoreRuntimeContext, input: DataStoreSelector & { limit?: unknown; offset?: unknown; sortBy?: unknown; direction?: unknown; keyPrefix?: unknown }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const limit = safe(() => normalizeListLimit(input.limit));
    const offset = safe(() => normalizeOffset(input.offset));
    const sortBy = normalizeSortBy(input.sortBy);
    const direction = normalizeSortDirection(input.direction);
    const now = new Date();
    const where: Prisma.DataStoreRecordWhereInput = {
      organizationId: context.organizationId,
      dataStoreId: store.id,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(typeof input.keyPrefix === "string" && input.keyPrefix ? { key: { startsWith: input.keyPrefix } } : {})
    };
    const orderBy = sortBy === "createdAt" ? [{ createdAt: direction }, { id: "asc" as const }] : sortBy === "updatedAt" ? [{ updatedAt: direction }, { id: "asc" as const }] : [{ key: direction }, { id: "asc" as const }];
    const items = await this.prisma.dataStoreRecord.findMany({ where, orderBy, skip: offset, take: limit + 1 });
    const visible = items.slice(0, limit);
    this.record("list", "success", started);
    return {
      items: visible.map((record) => ({
        key: record.key,
        valuePreview: dataStorePreview(record.valueJson),
        metadata: record.metadataJson,
        version: record.version,
        timestamps: timestamps(record)
      })),
      limit,
      offset,
      hasMore: items.length > limit
    };
    } catch (error) {
      this.record("list", "error", started, errorCategory(error));
      throw error;
    }
  }

  async upsert(context: DataStoreRuntimeContext, input: DataStoreSelector & {
    key: unknown;
    value: unknown;
    metadata?: unknown;
    ttlSeconds?: unknown;
    mode?: unknown;
    optimisticConcurrency?: unknown;
    expectedVersion?: unknown;
  }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const key = safe(() => assertDataStoreKey(input.key));
    const incoming = safe(() => assertDataStoreValue(input.value));
    const metadata = safe(() => assertDataStoreMetadata(input.metadata));
    const expiresAt = safe(() => ttlSecondsToExpiresAt(input.ttlSeconds));
    const mode = normalizeUpsertMode(input.mode);
    const optimistic = input.optimisticConcurrency === true;
    const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null || input.expectedVersion === "" ? undefined : Number(input.expectedVersion);
    if (optimistic && (expectedVersion === undefined || !Number.isInteger(expectedVersion) || expectedVersion < 1)) throw new NonRetryableStepError("Data Store expectedVersion must be a positive integer");
    const expected = expectedVersion as number | undefined;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.dataStoreRecord.findFirst({ where: { organizationId: context.organizationId, dataStoreId: store.id, key, deletedAt: null } });
      if (existing && isExpired(existing)) {
        await this.markExpired(existing, context, tx);
      }
      const active = existing && !isExpired(existing) ? existing : null;
      if (!active) {
        const count = await tx.dataStoreRecord.count({ where: { organizationId: context.organizationId, dataStoreId: store.id, deletedAt: null } });
        if (count >= DATA_STORE_LIMITS.maxRecordsPerStore) throw new NonRetryableStepError("Data Store record limit exceeded");
        const created = await tx.dataStoreRecord.create({
          data: { organizationId: context.organizationId, dataStoreId: store.id, key, valueJson: toJson(incoming), metadataJson: toJson(metadata), expiresAt, version: 1 }
        });
        await this.audit(context, "datastore.record.created", created.id, { dataStoreId: store.id, key, version: 1 }, tx);
        await this.events?.emit(tx, { organizationId: context.organizationId, type: "DATA_STORE_RECORD_CREATED", source: { type: "execution", id: context.executionId }, subject: { type: "data_store_record", id: created.id }, data: { dataStoreId: store.id, recordId: created.id, key, version: 1, value: created.valueJson }, causality: causal(context) });
        this.record("upsert", "created", started);
        return { created: true, updated: false, version: created.version, value: created.valueJson };
      }
      if (optimistic && active.version !== expected) throw new NonRetryableStepError("Data Store version conflict");
      const value = mode === "merge" ? safe(() => mergeJsonObjects(active.valueJson, incoming)) : incoming;
      const updated = await tx.dataStoreRecord.update({
        where: { id: active.id },
        data: { valueJson: toJson(value), metadataJson: toJson(metadata), expiresAt, version: { increment: 1 } }
      });
      await this.audit(context, "datastore.record.updated", updated.id, { dataStoreId: store.id, key, version: updated.version, previousVersion: active.version, mode }, tx);
      await this.events?.emit(tx, { organizationId: context.organizationId, type: "DATA_STORE_RECORD_UPDATED", source: { type: "execution", id: context.executionId }, subject: { type: "data_store_record", id: updated.id }, data: { dataStoreId: store.id, recordId: updated.id, key, version: updated.version, previousVersion: active.version, value: updated.valueJson }, causality: causal(context) });
      this.record("upsert", "updated", started);
      return { created: false, updated: true, version: updated.version, value: updated.valueJson };
    });
    } catch (error) {
      this.record("upsert", "error", started, errorCategory(error));
      throw error;
    }
  }

  async delete(context: DataStoreRuntimeContext, input: DataStoreSelector & { key: unknown }) {
    const started = Date.now();
    try {
    const store = await this.resolveStore(context.organizationId, input);
    const key = safe(() => assertDataStoreKey(input.key));
    const record = await this.prisma.dataStoreRecord.findFirst({ where: { organizationId: context.organizationId, dataStoreId: store.id, key, deletedAt: null } });
    if (!record) {
      this.record("delete", "miss", started);
      return { deleted: false, existed: false };
    }
    if (isExpired(record)) {
      await this.markExpired(record, context);
      this.record("delete", "ttl_expired", started);
      return { deleted: false, existed: false };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.dataStoreRecord.update({ where: { id: record.id }, data: { deletedAt: new Date() } });
      await this.audit(context, "datastore.record.deleted", record.id, { dataStoreId: store.id, key, version: record.version }, tx);
      await this.events?.emit(tx, { organizationId: context.organizationId, type: "DATA_STORE_RECORD_DELETED", source: { type: "execution", id: context.executionId }, subject: { type: "data_store_record", id: record.id }, data: { dataStoreId: store.id, recordId: record.id, key, version: record.version, value: record.valueJson }, causality: causal(context) });
    });
    this.record("delete", "deleted", started);
    return { deleted: true, existed: true };
    } catch (error) {
      this.record("delete", "error", started, errorCategory(error));
      throw error;
    }
  }

  private async resolveStore(organizationId: string, selector: DataStoreSelector) {
    const normalized = safe(() => assertDataStoreSelector(selector));
    const store = await this.prisma.dataStore.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        ...(normalized.dataStoreId ? { id: normalized.dataStoreId } : { name: { equals: normalized.dataStoreName, mode: "insensitive" } })
      }
    });
    if (!store) throw new NonRetryableStepError("Data Store not found");
    return store;
  }

  private async markExpired(record: { id: string; organizationId: string; dataStoreId: string; key: string; version: number }, context: DataStoreRuntimeContext, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    await tx.dataStoreRecord.updateMany({ where: { id: record.id, deletedAt: null }, data: { deletedAt: new Date() } });
    await this.audit(context, "datastore.record.ttl_expired", record.id, { dataStoreId: record.dataStoreId, key: record.key, version: record.version }, tx);
  }

  private audit(context: DataStoreRuntimeContext, action: string, resourceId: string, metadata: Record<string, unknown>, tx: Prisma.TransactionClient | PrismaService) {
    return tx.auditLog.create({
      data: {
        organizationId: context.organizationId,
        actorUserId: null,
        action,
        resourceType: "DataStoreRecord",
        resourceId,
        correlationId: context.correlationId ?? null,
        metadataJson: toJson({ ...metadata, executionId: context.executionId, stepExecutionId: context.stepExecutionId })
      }
    }).catch(() => undefined);
  }

  private record(operation: string, outcome: string, started: number, category?: string) {
    this.metrics?.recordDataStore(operation, outcome, (Date.now() - started) / 1000, category);
  }
}

function safe<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DataStoreValidationError) throw new NonRetryableStepError((error as Error).message);
    throw error;
  }
}

function isExpired(record: { expiresAt: Date | null }) {
  return Boolean(record.expiresAt && record.expiresAt <= new Date());
}

function timestamps(record: { createdAt: Date; updatedAt: Date; expiresAt: Date | null; deletedAt?: Date | null }) {
  return {
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    deletedAt: record.deletedAt ?? null
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorCategory(error: unknown) {
  if (error instanceof NonRetryableStepError) return "validation";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("prisma") || message.includes("database")) return "database";
  return "unknown";
}

function causal(context: DataStoreRuntimeContext) { return context.eventRootId ? { rootEventId: context.eventRootId, causationId: context.eventCausationId, depth: context.eventDepth, correlationId: context.correlationId } : { correlationId: context.correlationId }; }
