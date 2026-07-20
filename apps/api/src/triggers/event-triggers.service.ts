import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isInternalEventType, normalizeEventTriggerFilters, type EventTriggerFilters, type InternalEventType } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateEventTriggerDto, ListEventTriggersDto, UpdateEventTriggerDto } from "./dto/event-trigger.dto";

@Injectable()
export class EventTriggersService {
  constructor(private readonly prisma: PrismaService, private readonly audits?: AuditLogsService) {}

  async create(organizationId: string, userId: string, workflowId: string, dto: CreateEventTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const filters = this.filters(dto.eventType, dto.filters);
    await this.assertFilterResources(organizationId, dto.eventType, filters);
    const trigger = await this.prisma.trigger.create({ data: {
      organizationId, workflowId, type: "event", eventType: dto.eventType, enabled: dto.enabled ?? true,
      configJson: json({ name: dto.name.trim(), filters })
    } });
    await this.audit(organizationId, userId, "event.trigger.created", trigger.id, workflowId, dto.eventType);
    return summary(trigger);
  }

  async list(organizationId: string, workflowId: string, query: ListEventTriggersDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const limit = Math.min(query.limit ?? 20, 100); const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.trigger.findMany({ where: { organizationId, workflowId, type: "event", deletedAt: null, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
    const hasMore = rows.length > limit; const items = rows.slice(0, limit);
    return { items: items.map(summary), pageSize: limit, hasMore, nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null };
  }

  async get(organizationId: string, workflowId: string, triggerId: string) { return summary(await this.find(organizationId, workflowId, triggerId)); }

  async update(organizationId: string, userId: string, workflowId: string, triggerId: string, dto: UpdateEventTriggerDto) {
    const current = await this.find(organizationId, workflowId, triggerId);
    const currentConfig = config(current.configJson);
    const eventType = dto.eventType ?? current.eventType;
    if (!isInternalEventType(eventType)) throw new BadRequestException("Invalid internal event type");
    const filters = this.filters(eventType, dto.filters ?? currentConfig.filters);
    await this.assertFilterResources(organizationId, eventType, filters);
    const trigger = await this.prisma.trigger.update({ where: { id: triggerId }, data: {
      eventType, configJson: json({ name: dto.name?.trim() ?? currentConfig.name, filters })
    } });
    await this.audit(organizationId, userId, "event.trigger.updated", trigger.id, workflowId, eventType);
    return summary(trigger);
  }

  async setEnabled(organizationId: string, userId: string, workflowId: string, triggerId: string, enabled: boolean) {
    const result = await this.prisma.trigger.updateMany({ where: { id: triggerId, organizationId, workflowId, type: "event", deletedAt: null }, data: { enabled } });
    if (!result.count) throw new NotFoundException("Event trigger not found");
    const trigger = await this.find(organizationId, workflowId, triggerId);
    await this.audit(organizationId, userId, enabled ? "event.trigger.enabled" : "event.trigger.disabled", trigger.id, workflowId, trigger.eventType!);
    return summary(trigger);
  }

  async delete(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    const trigger = await this.find(organizationId, workflowId, triggerId);
    await this.prisma.trigger.update({ where: { id: triggerId }, data: { enabled: false, deletedAt: new Date() } });
    await this.audit(organizationId, userId, "event.trigger.deleted", trigger.id, workflowId, trigger.eventType!);
    return { deleted: true as const };
  }

  private filters(eventType: InternalEventType, value: unknown) { try { return normalizeEventTriggerFilters(eventType, value); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Invalid event filters"); } }
  private async assertFilterResources(organizationId: string, eventType: InternalEventType, filters: EventTriggerFilters) {
    if (filters.dataStoreId) {
      const found = await this.prisma.dataStore.count({ where: { id: filters.dataStoreId, organizationId, deletedAt: null } });
      if (!found) throw new NotFoundException("Filter resource not found");
    }
    if (filters.workflowId) {
      const found = await this.prisma.workflow.count({ where: { id: filters.workflowId, organizationId } });
      if (!found) throw new NotFoundException("Filter resource not found");
    }
  }
  private async assertWorkflow(organizationId: string, workflowId: string) { if (!await this.prisma.workflow.count({ where: { id: workflowId, organizationId } })) throw new NotFoundException("Workflow not found"); }
  private async find(organizationId: string, workflowId: string, triggerId: string) { const row = await this.prisma.trigger.findFirst({ where: { id: triggerId, organizationId, workflowId, type: "event", deletedAt: null } }); if (!row) throw new NotFoundException("Event trigger not found"); return row; }
  private audit(organizationId: string, actorUserId: string, action: string, resourceId: string, workflowId: string, eventType: string) { return this.audits?.record({ organizationId, actorUserId, action, resourceType: "Trigger", resourceId, metadata: { workflowId, eventType } }); }
}

function config(value: unknown) { const row = value && typeof value === "object" && !Array.isArray(value) ? value as any : {}; return { name: typeof row.name === "string" ? row.name : "Internal event", filters: row.filters ?? {} }; }
function summary(trigger: any) { const stored = config(trigger.configJson); return { id: trigger.id, type: "event" as const, workflowId: trigger.workflowId, eventType: trigger.eventType, enabled: trigger.enabled, name: stored.name, filters: stored.filters, createdAt: trigger.createdAt, updatedAt: trigger.updatedAt, lastReceivedAt: trigger.lastReceivedAt, lastExecutionId: trigger.lastExecutionId }; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function encodeCursor(row: { id: string; createdAt: Date }) { return Buffer.from(JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() })).toString("base64url"); }
function decodeCursor(value?: string) { if (!value) return null; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); const createdAt = new Date(parsed.createdAt); if (!parsed.id || Number.isNaN(createdAt.valueOf())) throw new Error(); return { id: String(parsed.id), createdAt }; } catch { throw new BadRequestException("Invalid event trigger cursor"); } }
