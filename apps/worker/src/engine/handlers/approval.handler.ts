import { Injectable } from "@nestjs/common";
import { ApprovalStatus, Prisma } from "@prisma/client";
import { normalizeApprovalConfig, StepExecutionStatus, StepType, type ExecutionContext, type StepResult, type WorkflowStepDefinition } from "@automation/shared-types";
import { PrismaService } from "../../prisma/prisma.service";
import type { StepHandler } from "../types";
import { WorkerMetricsService } from "../../metrics/worker-metrics.service";

@Injectable()
export class ApprovalHandler implements StepHandler {
  readonly type = StepType.Approval;
  constructor(private readonly prisma: PrismaService, private readonly metrics?: WorkerMetricsService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const runtime = record(context.metadata?.runtime);
    const executionId = String(runtime.executionId ?? "");
    const stepExecutionId = String(runtime.stepExecutionId ?? "");
    const organizationId = String(runtime.organizationId ?? "");
    if (!executionId || !stepExecutionId || !organizationId) throw new Error("APPROVAL runtime identity is missing");
    const existing = await this.prisma.approvalRequest.findUnique({ where: { stepExecutionId } });
    if (existing && existing.status !== ApprovalStatus.PENDING) {
      if (existing.status === ApprovalStatus.CANCELLED) throw new Error("Approval was cancelled");
      return {
        status: StepExecutionStatus.Completed,
        output: {
          decision: existing.status.toLowerCase(),
          decidedAt: existing.decidedAt?.toISOString() ?? existing.updatedAt.toISOString(),
          decidedByUserId: existing.decidedByUserId ?? null
        }
      };
    }
    if (!existing) {
      const config = normalizeApprovalConfig(step.config);
      const execution = await this.prisma.execution.findFirstOrThrow({ where: { id: executionId, organizationId }, select: { workflowId: true, workflowVersionId: true, correlationId: true } });
      const now = new Date();
      const expiresAt = config.expirationSeconds ? new Date(now.getTime() + config.expirationSeconds * 1000) : null;
      await this.prisma.$transaction(async (tx) => {
        const approval = await tx.approvalRequest.upsert({
          where: { stepExecutionId }, update: {},
          create: {
            organizationId, executionId, stepExecutionId, workflowId: execution.workflowId,
            workflowVersionId: execution.workflowVersionId, stepKey: step.key,
            executionPath: String(runtime.executionPath ?? "root"),
            iterationIndex: typeof runtime.iterationIndex === "number" ? runtime.iterationIndex : null,
            title: config.title, description: config.description, summary: config.summary,
            assigneePolicy: config.assigneePolicy, allowedRoles: config.allowedRoles, expiresAt
          }
        });
        await tx.auditLog.create({ data: { organizationId, actorUserId: null, action: "approval.requested", resourceType: "ApprovalRequest", resourceId: approval.id, correlationId: execution.correlationId, metadataJson: json({ workflowId: execution.workflowId, executionId, stepKey: step.key, outcome: "pending" }) } });
      });
      this.metrics?.approvalRequests.inc({ assignee_policy: config.assigneePolicy.toLowerCase() });
    }
    return { status: StepExecutionStatus.Completed, output: { waitReason: "approval" }, control: { waitReason: "approval", durableWait: true } };
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
