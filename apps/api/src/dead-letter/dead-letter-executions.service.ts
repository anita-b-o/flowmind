import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class DeadLetterExecutionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: { page?: number; pageSize?: number }) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where = { organizationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.deadLetterExecution.findMany({
        where,
        include: { execution: { select: { correlationId: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.deadLetterExecution.count({ where })
    ]);
    return { items: items.map(sanitize), page, pageSize, total };
  }

  async get(organizationId: string, id: string) {
    const item = await this.prisma.deadLetterExecution.findFirst({ where: { id, organizationId }, include: { execution: { select: { correlationId: true } } } });
    if (!item) throw new NotFoundException("Dead letter execution not found");
    return sanitize(item);
  }
}

function sanitize(item: any) {
  return {
    id: item.id,
    organizationId: item.organizationId,
    executionId: item.executionId,
    correlationId: item.execution?.correlationId ?? null,
    workflowId: item.workflowId,
    workflowVersionId: item.workflowVersionId,
    sourceQueue: item.sourceQueue,
    reason: item.reason,
    failedStepKey: item.failedStepKey,
    failedStepExecutionId: item.failedStepExecutionId,
    attempts: item.attempts,
    lastError: item.lastErrorJson,
    jobId: item.jobId,
    retryExecutionId: item.retryExecutionId,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution
  };
}
