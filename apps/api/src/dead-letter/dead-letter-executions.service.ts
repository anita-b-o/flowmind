import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { publicError } from "../common/public-sanitizer";
import { ListDeadLetterExecutionsQueryDto } from "./dto/list-dead-letter-executions-query.dto";
import { publicDeadLetterReason, type PublicDeadLetterReason } from "./dead-letter-reasons";

@Injectable()
export class DeadLetterExecutionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListDeadLetterExecutionsQueryDto) {
    assertDateRange(query.from, query.to);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.DeadLetterExecutionWhereInput = {
      organizationId,
      ...(query.status === "active" ? { resolvedAt: null } : {}),
      ...(query.status === "resolved" ? { resolvedAt: { not: null } } : {}),
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.reason ? { reason: { in: internalReasons(query.reason) } } : {}),
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
      this.prisma.deadLetterExecution.findMany({
        where,
        include: {
          workflow: { select: { id: true, name: true } },
          execution: { select: { id: true, status: true, correlationId: true } }
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.deadLetterExecution.count({ where })
    ]);
    return { items: items.map(summary), page, pageSize, total };
  }

  async get(organizationId: string, id: string) {
    const item = await this.prisma.deadLetterExecution.findFirst({
      where: { id, organizationId },
      include: {
        workflow: { select: { id: true, name: true, status: true } },
        workflowVersion: { select: { id: true, versionNumber: true, status: true, createdAt: true } },
        execution: {
          select: {
            id: true,
            status: true,
            workflowId: true,
            workflowVersionId: true,
            correlationId: true,
            retryOfExecutionId: true,
            retryRequestedAt: true,
            retryReason: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true
          }
        },
        retryExecution: {
          select: {
            id: true,
            status: true,
            retryOfExecutionId: true,
            correlationId: true,
            createdAt: true,
            completedAt: true
          }
        }
      }
    });
    if (!item) throw new NotFoundException("Dead letter execution not found");
    return detail(item);
  }
}

function summary(item: any) {
  return {
    id: item.id,
    executionId: item.executionId,
    workflowId: item.workflowId,
    workflowName: item.workflow?.name ?? null,
    workflowVersionId: item.workflowVersionId,
    failedStepKey: item.failedStepKey,
    reason: publicDeadLetterReason(item.reason),
    attempts: item.attempts,
    active: !item.resolvedAt,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    retryExecutionId: item.retryExecutionId,
    correlationId: item.execution?.correlationId ?? null
  };
}

function detail(item: any) {
  return {
    ...summary(item),
    failedStepExecutionId: item.failedStepExecutionId,
    workflow: item.workflow,
    workflowVersion: item.workflowVersion,
    execution: {
      ...item.execution,
      durationMs: durationMs(item.execution?.startedAt, item.execution?.completedAt)
    },
    correlationId: item.execution?.correlationId ?? null,
    lastError: publicError(item.lastErrorJson),
    retryExecution: item.retryExecution
  };
}

function durationMs(start?: Date | null, end?: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

function internalReasons(reason: PublicDeadLetterReason) {
  const map: Record<PublicDeadLetterReason, string[]> = {
    non_retryable: ["non_retryable"],
    attempts_exhausted: ["attempts_exhausted", "failed"],
    ambiguous_effect: ["ambiguous_effect", "ambiguous"],
    inconsistent_state: ["inconsistent_state"],
    invalid_wait: ["invalid_wait"],
    branch_resolution_failed: ["branch_resolution_failed"],
    control_validation_failed: ["control_validation_failed"],
    execution_limit: ["execution_limit"],
    unknown: ["unknown"]
  };
  return map[reason];
}

function assertDateRange(from?: string, to?: string) {
  if (from && to && new Date(from) > new Date(to)) {
    throw new BadRequestException("from must be before to");
  }
}
