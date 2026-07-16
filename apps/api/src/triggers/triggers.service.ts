import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWebhookTriggerDto } from "./dto/create-webhook-trigger.dto";
import { WebhookTokenService } from "./webhook-token.service";
import { AuditLogsService } from "../audit-logs/audit-logs.service";

@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: WebhookTokenService,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async createWebhookTrigger(organizationId: string, userId: string, workflowId: string, dto: CreateWebhookTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const existing = await this.prisma.trigger.findFirst({
      where: { organizationId, workflowId, type: "webhook", enabled: true }
    });
    if (existing) {
      throw new ConflictException("Workflow already has an active webhook trigger");
    }

    const token = this.tokenService.generateToken();
    const trigger = await this.prisma.trigger.create({
      data: {
        organizationId,
        workflowId,
        type: "webhook",
        tokenHash: this.tokenService.hashToken(token),
        configJson: toJson({ name: dto.name ?? "Webhook" }),
        enabled: true
      }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "trigger.created",
      resourceType: "Trigger",
      resourceId: trigger.id,
      metadata: { workflowId, type: "webhook" }
    });

    return this.withOneTimeToken(trigger, workflowId, token);
  }

  async list(organizationId: string, workflowId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const triggers = await this.prisma.trigger.findMany({
      where: { organizationId, workflowId },
      orderBy: { createdAt: "desc" }
    });
    return triggers.map((trigger) => ({
      id: trigger.id,
      type: trigger.type,
      workflowId: trigger.workflowId,
      enabled: trigger.enabled,
      tokenAvailable: false,
      createdAt: trigger.createdAt,
      rotatedAt: trigger.rotatedAt
    }));
  }

  async rotate(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const token = this.tokenService.generateToken();
    const trigger = await this.prisma.trigger.updateMany({
      where: { id: triggerId, organizationId, workflowId, type: "webhook" },
      data: {
        tokenHash: this.tokenService.hashToken(token),
        rotatedAt: new Date()
      }
    });
    if (trigger.count !== 1) {
      throw new NotFoundException("Trigger not found");
    }
    const updated = await this.prisma.trigger.findFirstOrThrow({ where: { id: triggerId, organizationId, workflowId } });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "trigger.rotated",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, type: "webhook" }
    });
    return this.withOneTimeToken(updated, workflowId, token);
  }

  private async assertWorkflow(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) {
      throw new NotFoundException("Workflow not found");
    }
    return workflow;
  }

  private withOneTimeToken(trigger: { id: string; type: string; workflowId: string; enabled: boolean; createdAt: Date; rotatedAt: Date | null }, workflowId: string, token: string) {
    return {
      id: trigger.id,
      type: trigger.type,
      workflowId: trigger.workflowId,
      enabled: trigger.enabled,
      webhookUrl: this.tokenService.buildWebhookUrl(workflowId, token),
      token,
      tokenAvailable: true,
      createdAt: trigger.createdAt,
      rotatedAt: trigger.rotatedAt
    };
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
