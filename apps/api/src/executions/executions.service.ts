import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ExecutionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListExecutionsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.ExecutionWhereInput = {
      organizationId,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.execution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          workflowId: true,
          workflowVersionId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          createdAt: true
        }
      }),
      this.prisma.execution.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async getDetail(organizationId: string, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId },
      include: {
        workflow: { select: { id: true, name: true, status: true } },
        workflowVersion: { select: { id: true, versionNumber: true, status: true, createdAt: true } },
        steps: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!execution) {
      throw new NotFoundException("Execution not found");
    }
    return {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      workflow: execution.workflow,
      workflowVersion: execution.workflowVersion,
      status: execution.status,
      input: sanitizePayload(execution.inputJson),
      context: sanitizePayload(execution.contextJson),
      error: execution.errorJson,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      steps: execution.steps.map((step) => ({
        id: step.id,
        workflowStepId: step.workflowStepId,
        stepKey: step.stepKey,
        stepType: step.stepType,
        status: step.status,
        attempt: step.attempt,
        output: step.outputJson,
        error: step.errorJson,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs
      }))
    };
  }
}

function sanitizePayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (["authorization", "cookie", "set-cookie", "x-api-key"].includes(key.toLowerCase())) {
        return "[redacted]";
      }
      return entry;
    })
  );
}
