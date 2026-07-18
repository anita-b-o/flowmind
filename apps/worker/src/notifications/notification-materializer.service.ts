import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { InternalEventEnvelope } from "@automation/shared-types";
import type { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { NOTIFICATION_DELIVERIES_QUEUE, NOTIFICATION_DELIVER_JOB } from "../queues/queue.constants";
import { isNotificationEventType, matchesNotificationFilters, normalizeEmail, notificationIdempotency, safePayload, TEMPLATE_BY_EVENT, validEmail } from "./notification-domain";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

@Injectable()
export class NotificationMaterializerService {
  constructor(private readonly prisma: PrismaService, @InjectQueue(NOTIFICATION_DELIVERIES_QUEUE) private readonly queue: Queue, private readonly metrics?: WorkerMetricsService) {}

  async materialize(event: { id: string; organizationId: string; correlationId: string }, envelope: InternalEventEnvelope) {
    if (!isNotificationEventType(envelope.type)) return;
    const rules = await this.prisma.notificationRule.findMany({ where: { organizationId: event.organizationId, eventType: envelope.type, enabled: true, deletedAt: null }, include: { connection: { select: { status: true, type: true, deletedAt: true } } } });
    for (const rule of rules) {
      if (rule.connection.type !== "smtp" || rule.connection.status !== "ACTIVE" || rule.connection.deletedAt || !matchesNotificationFilters(envelope, rule.filtersJson)) continue;
      const recipients = await this.resolveRecipients(event.organizationId, envelope, rule.recipientConfigJson);
      const extras = await this.extras(event.organizationId, envelope);
      for (const recipient of recipients) {
        const requestId = await this.createRequest(event, envelope, rule, recipient, extras);
        this.metrics?.notificationRequests.inc({ channel: "email", outcome: requestId ? "created" : "duplicate" });
        if (requestId) await this.queue.add(NOTIFICATION_DELIVER_JOB, { requestId }, { jobId: `notification:${requestId}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false }).catch(() => undefined);
      }
    }
  }

  private async createRequest(event: any, envelope: InternalEventEnvelope, rule: any, recipient: string, extras: Record<string, unknown>) {
    const payload = safePayload(envelope, extras);
    const templateKey = rule.templateKey || TEMPLATE_BY_EVENT[envelope.type as keyof typeof TEMPLATE_BY_EVENT];
    const subject = preliminarySubject(templateKey, payload);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.notificationRequest.create({ data: { organizationId: event.organizationId, notificationRuleId: rule.id, sourceEventId: event.id, type: envelope.type, channel: "EMAIL", recipient, subject, templateKey, payloadJson: json(payload), idempotencyKey: notificationIdempotency(rule.id, envelope, recipient), correlationId: event.correlationId } });
        await tx.notificationDelivery.create({ data: { organizationId: event.organizationId, notificationRequestId: request.id, provider: "smtp" } });
        return request.id;
      });
    } catch (error: any) { if (error?.code === "P2002") return null; throw error; }
  }

  private async resolveRecipients(organizationId: string, envelope: InternalEventEnvelope, value: unknown) {
    const config = record(value);
    if (config.kind === "EMAILS") return unique((Array.isArray(config.emails) ? config.emails : []).map(String).map(normalizeEmail).filter(validEmail));
    if (config.kind !== "APPROVAL_ROLES" || !envelope.type.startsWith("APPROVAL_")) return [];
    const approvalId = String((envelope.data as any).approvalId ?? "");
    const approval = await this.prisma.approvalRequest.findFirst({ where: { id: approvalId, organizationId }, select: { allowedRoles: true } });
    if (!approval) return [];
    const configured = new Set((Array.isArray(config.roles) ? config.roles : []).map(String));
    const roles = approval.allowedRoles.filter((role) => configured.has(role));
    const members = await this.prisma.organizationMember.findMany({ where: { organizationId, status: "ACTIVE", role: { in: roles as any } }, include: { user: { select: { email: true, status: true } } } });
    return unique(members.filter((member) => member.user.status === "ACTIVE").map((member) => normalizeEmail(member.user.email)).filter(validEmail));
  }

  private async extras(organizationId: string, envelope: InternalEventEnvelope) {
    const data = envelope.data as any; const baseUrl = (process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    if (envelope.type.startsWith("APPROVAL_")) {
      const row = await this.prisma.approvalRequest.findFirst({ where: { id: String(data.approvalId), organizationId }, include: { workflow: { select: { name: true } } } });
      return row ? { title: row.title, description: row.description, workflowName: row.workflow.name, link: `${baseUrl}/approvals/${row.id}` } : {};
    }
    if (envelope.type.startsWith("EXECUTION_")) {
      const row = await this.prisma.execution.findFirst({ where: { id: String(data.executionId), organizationId }, include: { workflow: { select: { name: true } } } });
      return row ? { workflowName: row.workflow.name, title: row.workflow.name, link: `${baseUrl}/executions/${row.id}` } : {};
    }
    return { title: envelope.type.replaceAll("_", " ") };
  }
}
function preliminarySubject(key: string, payload: Record<string, unknown>) { return `${key}: ${String(payload.title ?? payload.workflowName ?? "FlowMind")}`.replace(/[\r\n]/g, " ").slice(0, 300); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function unique(values: string[]) { return [...new Set(values)]; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
