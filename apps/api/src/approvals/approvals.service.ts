import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ApprovalDecision, ApprovalStatus, ExecutionStatus, Prisma } from "@prisma/client";
import { APPROVAL_LIMITS, canDecideApproval } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import type { ListApprovalsQueryDto } from "./dto/approval.dto";
import { InternalEventEmitter } from "../internal-events/internal-event-emitter.service";

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService, private readonly queues: QueueService, private readonly metrics: ApiMetricsService, private readonly events: InternalEventEmitter) {}

  async list(organizationId: string, query: ListApprovalsQueryDto) {
    const where: Prisma.ApprovalRequestWhereInput = { organizationId, ...(query.status ? { status: query.status as ApprovalStatus } : {}), ...(query.workflowId ? { workflowId: query.workflowId } : {}), ...(query.executionId ? { executionId: query.executionId } : {}), ...((query.from || query.to) ? { requestedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.approvalRequest.findMany({ where, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { workflow: { select: { id: true, name: true } } } }),
      this.prisma.approvalRequest.count({ where })
    ]);
    return { items: items.map(publicApproval), page: query.page, pageSize: query.pageSize, total };
  }

  async detail(organizationId: string, id: string) {
    const item = await this.prisma.approvalRequest.findFirst({ where: { id, organizationId }, include: { workflow: { select: { id: true, name: true } } } });
    if (!item) throw new NotFoundException("Approval request not found");
    return publicApproval(item);
  }

  async decide(organizationId: string, userId: string, id: string, decision: "APPROVED" | "REJECTED", rawComment?: string) {
    const current = await this.prisma.approvalRequest.findFirst({ where: { id, organizationId }, include: { execution: { select: { status: true, workflowVersionId: true, correlationId: true, eventRootId: true, eventCausationId: true, eventDepth: true } } } });
    if (!current) throw new NotFoundException("Approval request not found");
    const membership = await this.prisma.organizationMember.findFirst({ where: { organizationId, userId, status: "ACTIVE" }, select: { role: true } });
    if (!membership || !canDecideApproval(membership.role, current.allowedRoles)) throw new ForbiddenException("You are not allowed to decide this approval");
    if (current.status !== ApprovalStatus.PENDING) throw new ConflictException("Approval request is no longer pending");
    const now = new Date();
    const comment = rawComment?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").trim().slice(0, APPROVAL_LIMITS.decisionComment) || null;
    const won = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.approvalRequest.updateMany({ where: { id, organizationId, status: ApprovalStatus.PENDING, version: current.version, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { status: decision as ApprovalStatus, decision: decision as ApprovalDecision, decisionComment: comment, decidedAt: now, decidedByUserId: userId, version: { increment: 1 } } });
      if (updated.count !== 1) return false;
      await tx.execution.updateMany({ where: { id: current.executionId, organizationId, status: ExecutionStatus.RETRYING, waitReason: "approval" }, data: { status: ExecutionStatus.QUEUED, waitReason: null } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: userId, action: `approval.${decision.toLowerCase()}`, resourceType: "ApprovalRequest", resourceId: id, correlationId: current.execution.correlationId, metadataJson: json({ workflowId: current.workflowId, executionId: current.executionId, stepKey: current.stepKey, outcome: decision.toLowerCase() }) } });
      await this.events.emit(tx, { organizationId, type: decision === "APPROVED" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED", source: { type: "approval", id }, subject: { type: "approval_request", id }, data: { approvalId: id, executionId: current.executionId, workflowId: current.workflowId, workflowVersionId: current.workflowVersionId, stepKey: current.stepKey, outcome: decision, requestedAt: current.requestedAt.toISOString(), decidedAt: now.toISOString() }, causality: current.execution.eventRootId ? { rootEventId: current.execution.eventRootId, causationId: current.execution.eventCausationId, depth: current.execution.eventDepth, correlationId: current.execution.correlationId } : { correlationId: current.execution.correlationId } });
      return true;
    });
    if (!won) throw new ConflictException("Approval request is no longer pending");
    this.metrics.approvalDecisions.inc({ outcome: decision.toLowerCase(), assignee_policy: current.assigneePolicy.toLowerCase() });
    this.metrics.approvalDecisionLatency.observe({ outcome: decision.toLowerCase(), assignee_policy: current.assigneePolicy.toLowerCase() }, Math.max(0, (now.getTime() - current.requestedAt.getTime()) / 1000));
    await this.queues.enqueueExecution(
      { organizationId, executionId: current.executionId, workflowId: current.workflowId, workflowVersionId: current.execution.workflowVersionId ?? undefined, requestId: newTraceId(), correlationId: current.execution.correlationId ?? newTraceId(), enqueuedAt: new Date().toISOString() },
      `execution-${current.executionId}-approval-${id}-v${current.version + 1}`
    ).catch(() => undefined);
    return this.detail(organizationId, id);
  }
}

function publicApproval(item: any) { return { id: item.id, status: item.status, title: item.title, description: item.description, summary: item.summary, assigneePolicy: item.assigneePolicy, allowedRoles: item.allowedRoles, requestedAt: item.requestedAt, expiresAt: item.expiresAt, decidedAt: item.decidedAt, decidedByUserId: item.decidedByUserId, decision: item.decision, decisionComment: item.decisionComment, workflow: item.workflow, workflowId: item.workflowId, workflowVersionId: item.workflowVersionId, executionId: item.executionId, stepExecutionId: item.stepExecutionId, stepKey: item.stepKey, executionPath: item.executionPath, iterationIndex: item.iterationIndex } as const; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
