import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { WorkerLoggerService } from "./worker-logger.service";

@Injectable()
export class DemoTelemetryService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private currentRun?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    private readonly logger: WorkerLoggerService
  ) {}

  onModuleInit() {
    if (process.env.FLOWMIND_DEPLOYMENT_PROFILE !== "demo-free") return;
    this.timer = setInterval(() => this.startSample(), intervalMs());
    this.timer.unref();
    this.startSample();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.currentRun;
  }

  private startSample() {
    if (this.currentRun || this.shutdown.isShuttingDown()) return;
    const run = this.sample().catch((error) => {
      this.logger.warn("demo.runtime.telemetry_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    this.currentRun = run.finally(() => {
      this.currentRun = undefined;
    });
  }

  private async sample() {
    const [executions, events, notifications, approvals] = await Promise.all([
      this.prisma.execution.count({
        where: { status: { in: ["PENDING", "QUEUED", "RUNNING", "RETRYING"] } }
      }),
      this.prisma.internalEvent.count({
        where: { status: { in: ["PENDING", "PROCESSING"] } }
      }),
      this.prisma.notificationRequest.count({
        where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } }
      }),
      this.prisma.approvalRequest.count({ where: { status: "PENDING" } })
    ]);
    this.logger.info("demo.runtime.telemetry", {
      profile: "demo-free",
      memoryRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      backlog: { executions, events, notifications, approvals }
    });
  }
}

function intervalMs() {
  const value = Number(process.env.DEMO_TELEMETRY_INTERVAL_MS ?? 60_000);
  return Number.isInteger(value) && value >= 10_000 && value <= 3_600_000
    ? value
    : 60_000;
}
