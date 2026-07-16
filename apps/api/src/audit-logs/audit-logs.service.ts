import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { sanitizePublic } from "../common/public-sanitizer";
import { ListAuditLogsQueryDto } from "./dto/list-audit-logs-query.dto";

export type AuditEventInput = {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListAuditLogsQueryDto) {
    assertDateRange(query.from, query.to);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.userId ? { actorUserId: query.userId } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.auditLog.count({ where })
    ]);
    const actorIds = [...new Set(items.map((item) => item.actorUserId).filter(Boolean))] as string[];
    const users = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [];
    const actors = new Map(users.map((user) => [user.id, { id: user.id, display: user.name || user.email }]));
    return {
      items: items.map((item) => ({
        id: item.id,
        action: item.action,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        actor: item.actorUserId ? actors.get(item.actorUserId) ?? { id: item.actorUserId, display: "Unknown user" } : null,
        correlationId: item.correlationId,
        metadata: sanitizePublic(item.metadataJson),
        createdAt: item.createdAt
      })),
      page,
      pageSize,
      total
    };
  }

  record(input: AuditEventInput, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    return tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: input.correlationId ?? null,
        metadataJson: toJson(sanitizePublic(input.metadata ?? {}))
      }
    });
  }

  async recordForUserOrganizations(input: Omit<AuditEventInput, "organizationId"> & { actorUserId: string }) {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId: input.actorUserId, status: "ACTIVE" },
      select: { organizationId: true }
    });
    if (memberships.length === 0) {
      return;
    }
    await this.prisma.$transaction(
      memberships.map((membership) => this.record({ ...input, organizationId: membership.organizationId }))
    );
  }
}

function assertDateRange(from?: string, to?: string) {
  if (from && to && new Date(from) > new Date(to)) {
    throw new BadRequestException("from must be before to");
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
