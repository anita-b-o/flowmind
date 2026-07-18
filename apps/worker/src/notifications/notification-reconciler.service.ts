import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { NOTIFICATION_DELIVERIES_QUEUE, NOTIFICATION_DELIVER_JOB } from "../queues/queue.constants";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

@Injectable()
export class NotificationReconcilerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout; private running = false;
  constructor(private readonly prisma: PrismaService, private readonly shutdown: ShutdownStateService, @InjectQueue(NOTIFICATION_DELIVERIES_QUEUE) private readonly queue: Queue, private readonly metrics?: WorkerMetricsService) {}
  onModuleInit() { this.timer = setInterval(() => void this.reconcile(), Number(process.env.NOTIFICATION_RECONCILIATION_INTERVAL_MS ?? 10_000)); this.timer.unref(); void this.reconcile(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  isActive() { return Boolean(this.timer) && !this.shutdown.isShuttingDown(); }
  async reconcile() {
    if (this.running || this.shutdown.isShuttingDown()) return; this.running = true;
    try {
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        const expired = await tx.notificationRequest.findMany({ where: { status: "PROCESSING", lockedUntil: { lt: now } }, select: { id: true } });
        if (expired.length) {
          await tx.notificationRequest.updateMany({ where: { id: { in: expired.map((row) => row.id) }, status: "PROCESSING", lockedUntil: { lt: now } }, data: { status: "FAILED", lockedBy: null, lockedUntil: null, nextAttemptAt: now } });
          await tx.notificationDelivery.updateMany({ where: { notificationRequestId: { in: expired.map((row) => row.id) }, status: "PROCESSING" }, data: { status: "FAILED", failedAt: now, errorCategory: "TRANSIENT", errorMessageSafe: "Delivery lease expired; outcome may be ambiguous" } });
        }
      });
      const due = await this.prisma.notificationRequest.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, scheduledAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: "asc" }, take: Number(process.env.NOTIFICATION_BATCH_SIZE ?? 100), select: { id: true } });
      for (const row of due) await this.queue.add(NOTIFICATION_DELIVER_JOB, { requestId: row.id }, { jobId: `notification:${row.id}:${Math.floor(Date.now() / 10_000)}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false }).catch(() => undefined);
      if (this.metrics) {
        const grouped = await this.prisma.notificationRequest.groupBy({ by: ["status"], _count: true });
        for (const item of grouped) this.metrics.notificationBacklog.set({ state: item.status.toLowerCase() }, item._count);
      }
    } finally { this.running = false; }
  }
}
