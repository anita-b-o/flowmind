import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  assertDataStoreDescription,
  assertDataStoreKey,
  assertDataStoreName,
  assertDataStoreMetadata,
  assertDataStoreValue,
  mergeJsonObjects,
  normalizeUpsertMode,
  ttlSecondsToExpiresAt,
  dataStorePreview,
  DATA_STORE_LIMITS,
  DataStoreValidationError
} from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDataStoreDto, ListDataStoreRecordsQueryDto, UpdateDataStoreDto } from "./dto/data-store.dto";
import { UpsertDataStoreRecordDto } from "./dto/data-store.dto";
import { InternalEventEmitter } from "../internal-events/internal-event-emitter.service";

@Injectable()
export class DataStoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs?: AuditLogsService,
    private readonly events?: InternalEventEmitter
  ) {}

  async list(organizationId: string) {
    const items = await this.prisma.dataStore.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { records: { where: activeRecordWhere() } } } }
    });
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      recordCount: item._count.records,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
  }

  async create(organizationId: string, actorUserId: string, dto: CreateDataStoreDto) {
    const name = mapValidation(() => assertDataStoreName(dto.name));
    const description = mapValidation(() => assertDataStoreDescription(dto.description));
    try {
      const store = await this.prisma.$transaction(async (tx) => {
        const created = await tx.dataStore.create({ data: { organizationId, name, description } });
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId,
            action: "datastore.created",
            resourceType: "DataStore",
            resourceId: created.id,
            metadata: { name }
          },
          tx
        );
        return created;
      });
      return this.toStoreDto(store, 0);
    } catch (error: any) {
      if (error?.code === "P2002") throw new ConflictException("A Data Store with this name already exists.");
      throw error;
    }
  }

  async detail(organizationId: string, dataStoreId: string) {
    const store = await this.prisma.dataStore.findFirst({
      where: { id: dataStoreId, organizationId, deletedAt: null },
      include: { _count: { select: { records: { where: activeRecordWhere() } } } }
    });
    if (!store) throw new NotFoundException("Data Store not found");
    return this.toStoreDto(store, store._count.records);
  }

  async update(organizationId: string, actorUserId: string, dataStoreId: string, dto: UpdateDataStoreDto) {
    const existing = await this.assertStore(organizationId, dataStoreId);
    const name = dto.name === undefined ? existing.name : mapValidation(() => assertDataStoreName(dto.name));
    const description = dto.description === undefined ? existing.description ?? undefined : mapValidation(() => assertDataStoreDescription(dto.description));
    try {
      const store = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.dataStore.update({ where: { id: dataStoreId }, data: { name, description } });
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId,
            action: "datastore.updated",
            resourceType: "DataStore",
            resourceId: dataStoreId,
            metadata: { name, changed: changedFields(existing, { name, description }) }
          },
          tx
        );
        return updated;
      });
      return this.toStoreDto(store, await this.activeRecordCount(dataStoreId));
    } catch (error: any) {
      if (error?.code === "P2002") throw new ConflictException("A Data Store with this name already exists.");
      throw error;
    }
  }

  async delete(organizationId: string, actorUserId: string, dataStoreId: string) {
    const store = await this.assertStore(organizationId, dataStoreId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.dataStore.update({ where: { id: dataStoreId }, data: { deletedAt: now } });
      await tx.dataStoreRecord.updateMany({ where: { organizationId, dataStoreId, deletedAt: null }, data: { deletedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId,
          action: "datastore.deleted",
          resourceType: "DataStore",
          resourceId: dataStoreId,
          metadata: { name: store.name }
        },
        tx
      );
    });
    return null;
  }

  async listRecords(organizationId: string, dataStoreId: string, query: ListDataStoreRecordsQueryDto) {
    await this.assertStore(organizationId, dataStoreId);
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(Math.max(1, Number(query.pageSize ?? 20)), DATA_STORE_LIMITS.maxListLimit);
    const now = new Date();
    const where: Prisma.DataStoreRecordWhereInput = {
      organizationId,
      dataStoreId,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(query.q ? { key: { contains: query.q, mode: "insensitive" } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.dataStoreRecord.findMany({
        where,
        orderBy: [{ key: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.dataStoreRecord.count({ where })
    ]);
    return {
      items: items.map((record) => this.toRecordDto(record, true)),
      page,
      pageSize,
      total
    };
  }

  async getRecord(organizationId: string, dataStoreId: string, key: string) {
    await this.assertStore(organizationId, dataStoreId);
    const safeKey = mapValidation(() => assertDataStoreKey(key));
    const record = await this.prisma.dataStoreRecord.findFirst({ where: { organizationId, dataStoreId, key: safeKey, deletedAt: null } });
    if (!record) throw new NotFoundException("Data Store record not found");
    if (isExpired(record)) {
      await this.markExpired(record, null);
      throw new NotFoundException("Data Store record not found");
    }
    return this.toRecordDto(record, false);
  }

  async deleteRecord(organizationId: string, actorUserId: string, dataStoreId: string, key: string) {
    await this.assertStore(organizationId, dataStoreId);
    const safeKey = mapValidation(() => assertDataStoreKey(key));
    const now = new Date();
    const record = await this.prisma.dataStoreRecord.findFirst({ where: { organizationId, dataStoreId, key: safeKey, deletedAt: null } });
    if (!record || isExpired(record)) {
      if (record && isExpired(record)) await this.markExpired(record, actorUserId);
      return { deleted: false, existed: false };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.dataStoreRecord.update({ where: { id: record.id }, data: { deletedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId,
          action: "datastore.record.deleted",
          resourceType: "DataStoreRecord",
          resourceId: record.id,
          metadata: { dataStoreId, key: safeKey, version: record.version }
        },
        tx
      );
      await this.events?.emit(tx, { organizationId, type: "DATA_STORE_RECORD_DELETED", source: { type: "api" }, subject: { type: "data_store_record", id: record.id }, data: { dataStoreId, recordId: record.id, key: safeKey, version: record.version, value: record.valueJson } });
    });
    return { deleted: true, existed: true };
  }

  async upsertRecord(organizationId: string, actorUserId: string, dataStoreId: string, rawKey: string, dto: UpsertDataStoreRecordDto) {
    await this.assertStore(organizationId, dataStoreId);
    const key = mapValidation(() => assertDataStoreKey(rawKey));
    const incoming = mapValidation(() => assertDataStoreValue(dto.value));
    const metadata = mapValidation(() => assertDataStoreMetadata(dto.metadata));
    const expiresAt = mapValidation(() => ttlSecondsToExpiresAt(dto.ttlSeconds));
    const mode = normalizeUpsertMode(dto.mode);
    if (dto.optimisticConcurrency && !dto.expectedVersion) throw new BadRequestException("expectedVersion is required with optimisticConcurrency");
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.dataStoreRecord.findFirst({ where: { organizationId, dataStoreId, key, deletedAt: null } });
      const active = existing && !isExpired(existing) ? existing : null;
      if (active && dto.optimisticConcurrency && active.version !== dto.expectedVersion) throw new ConflictException("Data Store version conflict");
      if (!active) {
        const count = await tx.dataStoreRecord.count({ where: { organizationId, dataStoreId, deletedAt: null } });
        if (count >= DATA_STORE_LIMITS.maxRecordsPerStore) throw new ConflictException("Data Store record limit exceeded");
        const created = await tx.dataStoreRecord.create({ data: { organizationId, dataStoreId, key, valueJson: toJson(incoming), metadataJson: toJson(metadata), expiresAt } });
        await this.auditLogs?.record({ organizationId, actorUserId, action: "datastore.record.created", resourceType: "DataStoreRecord", resourceId: created.id, metadata: { dataStoreId, key, version: created.version } }, tx);
        await this.events?.emit(tx, { organizationId, type: "DATA_STORE_RECORD_CREATED", source: { type: "api" }, subject: { type: "data_store_record", id: created.id }, data: { dataStoreId, recordId: created.id, key, version: created.version, value: created.valueJson } });
        return this.toRecordDto(created, false);
      }
      const value = mode === "merge" ? mapValidation(() => mergeJsonObjects(active.valueJson, incoming)) : incoming;
      const updated = await tx.dataStoreRecord.update({ where: { id: active.id }, data: { valueJson: toJson(value), metadataJson: toJson(metadata), expiresAt, version: { increment: 1 } } });
      await this.auditLogs?.record({ organizationId, actorUserId, action: "datastore.record.updated", resourceType: "DataStoreRecord", resourceId: updated.id, metadata: { dataStoreId, key, version: updated.version, previousVersion: active.version, mode } }, tx);
      await this.events?.emit(tx, { organizationId, type: "DATA_STORE_RECORD_UPDATED", source: { type: "api" }, subject: { type: "data_store_record", id: updated.id }, data: { dataStoreId, recordId: updated.id, key, version: updated.version, previousVersion: active.version, value: updated.valueJson } });
      return this.toRecordDto(updated, false);
    });
  }

  private async assertStore(organizationId: string, dataStoreId: string) {
    const store = await this.prisma.dataStore.findFirst({ where: { id: dataStoreId, organizationId, deletedAt: null } });
    if (!store) throw new NotFoundException("Data Store not found");
    return store;
  }

  private activeRecordCount(dataStoreId: string) {
    return this.prisma.dataStoreRecord.count({ where: activeRecordWhere(dataStoreId) });
  }

  private toStoreDto(store: { id: string; name: string; description: string | null; createdAt: Date; updatedAt: Date }, recordCount: number) {
    return {
      id: store.id,
      name: store.name,
      description: store.description,
      recordCount,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt
    };
  }

  private toRecordDto(record: {
    id: string;
    key: string;
    valueJson: unknown;
    metadataJson: unknown;
    version: number;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }, preview: boolean) {
    return {
      id: record.id,
      key: record.key,
      value: preview ? dataStorePreview(record.valueJson) : record.valueJson,
      metadata: record.metadataJson,
      version: record.version,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  private async markExpired(record: { id: string; organizationId: string; dataStoreId: string; key: string; version: number }, actorUserId: string | null) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.dataStoreRecord.updateMany({ where: { id: record.id, deletedAt: null }, data: { deletedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId: record.organizationId,
          actorUserId,
          action: "datastore.record.ttl_expired",
          resourceType: "DataStoreRecord",
          resourceId: record.id,
          metadata: { dataStoreId: record.dataStoreId, key: record.key, version: record.version }
        },
        tx
      );
    });
  }
}

function activeRecordWhere(dataStoreId?: string): Prisma.DataStoreRecordWhereInput {
  return {
    ...(dataStoreId ? { dataStoreId } : {}),
    deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
  };
}

function isExpired(record: { expiresAt: Date | null }) {
  return Boolean(record.expiresAt && record.expiresAt <= new Date());
}

function changedFields(before: { name: string; description: string | null }, after: { name: string; description?: string | null }) {
  return {
    name: before.name !== after.name,
    description: (before.description ?? undefined) !== (after.description ?? undefined)
  };
}

function mapValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DataStoreValidationError) throw new BadRequestException({ code: error.code, message: error.message });
    throw error;
  }
}

function toJson(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
