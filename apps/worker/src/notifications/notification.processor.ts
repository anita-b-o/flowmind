import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Job } from "bullmq";
import { Prisma, NotificationErrorCategory } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConnectionResolver } from "../connections/connection-resolver";
import { WorkerIdentityService } from "../runtime/worker-identity.service";
import { NOTIFICATION_DELIVERIES_QUEUE, NOTIFICATION_DELIVER_JOB } from "../queues/queue.constants";
import { EmailProvider } from "./email-provider";
import { NotificationTemplates } from "./notification-templates";
import { validEmail } from "./notification-domain";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

@Injectable()
@Processor(NOTIFICATION_DELIVERIES_QUEUE)
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService, private readonly identity: WorkerIdentityService, private readonly connections: ConnectionResolver, private readonly templates: NotificationTemplates, private readonly provider: EmailProvider, private readonly metrics?: WorkerMetricsService) { super(); }
  async process(job: Job<{ requestId: string }>) { if (job.name === NOTIFICATION_DELIVER_JOB) await this.deliver(job.data.requestId); }

  async deliver(requestId: string) {
    const now = new Date(); const leaseMs = intEnv("NOTIFICATION_LEASE_MS", 60_000, 5_000, 300_000);
    const claimed = await this.prisma.notificationRequest.updateMany({ where: { id: requestId, status: { in: ["PENDING", "FAILED"] }, scheduledAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }], AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }] }, data: { status: "PROCESSING", lockedBy: this.identity.id, lockedUntil: new Date(now.getTime() + leaseMs) } });
    if (!claimed.count) return;
    const request = await this.prisma.notificationRequest.findUniqueOrThrow({ where: { id: requestId }, include: { rule: true, delivery: true } });
    try {
      if (!validEmail(request.recipient)) throw permanent("INVALID_RECIPIENT", NotificationErrorCategory.INVALID_RECIPIENT);
      const payload = record(request.payloadJson); const rendered = this.templates.render(request.templateKey, payload);
      const connection = await this.connections.resolveSmtp(request.organizationId, request.rule.connectionId);
      await this.prisma.notificationDelivery.update({ where: { notificationRequestId: request.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now, status: "PROCESSING" } });
      const result = await this.provider.send({ to: request.recipient, subject: rendered.subject, html: rendered.html, text: rendered.text, connection });
      const sentAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationRequest.update({ where: { id: request.id }, data: { status: "SENT", subject: rendered.subject, lockedBy: null, lockedUntil: null, nextAttemptAt: null } });
        await tx.notificationDelivery.update({ where: { notificationRequestId: request.id }, data: { status: "SENT", sentAt, failedAt: null, providerMessageId: result.messageId?.slice(0, 500), errorCategory: null, errorMessageSafe: null } });
        await tx.auditLog.create({ data: { organizationId: request.organizationId, actorUserId: null, action: "notification.sent", resourceType: "NotificationRequest", resourceId: request.id, correlationId: request.correlationId, metadataJson: json({ channel: request.channel, type: request.type, outcome: "sent" }) } });
      });
      this.metrics?.notificationDeliveries.inc({ channel: "email", outcome: "sent", error_category: "none" });
      this.metrics?.notificationDeliveryLatency.observe({ channel: "email", outcome: "sent" }, Math.max(0, (sentAt.getTime() - request.createdAt.getTime()) / 1000));
    } catch (error) { await this.fail(request, error); }
  }

  private async fail(request: any, error: unknown) {
    const classification = classify(error); const current = await this.prisma.notificationDelivery.findUniqueOrThrow({ where: { notificationRequestId: request.id } });
    const attempts = Math.max(current.attempts, 1); const dead = classification.permanent || attempts >= intEnv("NOTIFICATION_MAX_ATTEMPTS", 5, 1, 20);
    const next = dead ? null : new Date(Date.now() + Math.min(intEnv("NOTIFICATION_MAX_BACKOFF_MS", 300_000, 1_000, 3_600_000), 1_000 * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 1_000));
    await this.prisma.$transaction(async (tx) => {
      await tx.notificationRequest.update({ where: { id: request.id }, data: { status: dead ? "DEAD_LETTER" : "FAILED", nextAttemptAt: next, lockedBy: null, lockedUntil: null } });
      await tx.notificationDelivery.update({ where: { notificationRequestId: request.id }, data: { status: dead ? "DEAD_LETTER" : "FAILED", attempts: current.attempts || 1, lastAttemptAt: current.lastAttemptAt ?? new Date(), failedAt: new Date(), errorCategory: classification.category, errorMessageSafe: classification.message } });
      await tx.auditLog.create({ data: { organizationId: request.organizationId, actorUserId: null, action: dead ? "notification.dead_letter" : "notification.failed", resourceType: "NotificationRequest", resourceId: request.id, correlationId: request.correlationId, metadataJson: json({ channel: request.channel, type: request.type, outcome: dead ? "dead_letter" : "retry", errorCategory: classification.category }) } });
    });
    this.metrics?.notificationDeliveries.inc({ channel: "email", outcome: dead ? "dead_letter" : "failed", error_category: classification.category.toLowerCase() });
    if (!dead) this.metrics?.notificationRetries.inc({ channel: "email", error_category: classification.category.toLowerCase() });
  }
}
function classify(error: any): { permanent: boolean; category: NotificationErrorCategory; message: string } {
  if (error?.permanent) return { permanent: true, category: error.category ?? NotificationErrorCategory.CONFIGURATION, message: safeMessage(error) };
  const code = String(error?.code ?? "").toUpperCase(); const signature = `${code} ${String(error?.name ?? "")} ${String(error?.message ?? "")}`.toUpperCase(); const responseCode = Number(error?.responseCode ?? 0);
  if (signature.includes("TEMPLATE")) return { permanent: true, category: NotificationErrorCategory.TEMPLATE, message: "Notification template is invalid" };
  if (signature.includes("NONRETRYABLESTEPERROR") || signature.includes("CONNECTION_") || signature.includes("INVALID_CONNECTION") || ["EAUTH", "EENVELOPE"].includes(code)) return { permanent: true, category: NotificationErrorCategory.CONFIGURATION, message: "SMTP connection configuration is invalid" };
  if (responseCode >= 500) return { permanent: true, category: NotificationErrorCategory.PROVIDER_REJECTED, message: `SMTP rejected the message (${responseCode})` };
  return { permanent: false, category: NotificationErrorCategory.TRANSIENT, message: "Temporary SMTP delivery failure" };
}
function permanent(code: string, category: NotificationErrorCategory) { return Object.assign(new Error(code), { code, category, permanent: true }); }
function safeMessage(error: any) { return String(error?.message ?? "Notification delivery failed").replace(/(password|token|secret|smtp)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]").slice(0, 300); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function intEnv(name: string, fallback: number, min: number, max: number) { const value = Number(process.env[name] ?? fallback); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
