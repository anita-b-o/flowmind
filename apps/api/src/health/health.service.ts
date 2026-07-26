import { Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { EmbeddedWorkerHealthBridge } from "./embedded-worker-health.bridge";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    private readonly logger?: StructuredLoggerService,
    private readonly metrics?: ApiMetricsService,
    private readonly embeddedWorker?: EmbeddedWorkerHealthBridge
  ) {}

  async ready() {
    const checks: Record<string, string> = {};
    checks.config = process.env.DATABASE_URL && process.env.REDIS_URL && process.env.JWT_ACCESS_SECRET ? "valid" : "invalid";
    checks.shutdown = this.shutdown.isShuttingDown() ? "draining" : "ok";
    checks.database = await this.checkDatabase();
    checks.redis = await this.checkRedis();
    if (process.env.FLOWMIND_DEPLOYMENT_PROFILE === "demo-free") {
      const worker = await this.embeddedWorker?.ready();
      checks.embeddedWorker = worker?.status === "ready" ? "up" : "down";
      for (const [name, value] of Object.entries(worker?.checks ?? {})) {
        checks[`worker.${name}`] = value;
      }
    }
    const accepted = ["up", "valid", "ok", "ready", "disabled"];
    const ready = Object.values(checks).every((value) => accepted.includes(value));
    if (!ready) {
      for (const [key, value] of Object.entries(checks)) {
        if (!accepted.includes(value)) {
          this.metrics?.readinessFailures.inc({ reason_code: key });
        }
      }
      this.logger?.warn("api.health.readiness_failed", { checks });
    }
    const result = {
      status: ready ? "ready" : "not_ready",
      checks
    };
    return process.env.FLOWMIND_DEPLOYMENT_PROFILE === "demo-free"
      ? {
          ...result,
          profile: "demo-free",
          memoryRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024)
        }
      : result;
  }

  private async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkRedis() {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 500,
      enableOfflineQueue: false,
      retryStrategy: () => null
    });
    try {
      await redis.connect();
      await redis.ping();
      return "up";
    } catch {
      return "down";
    } finally {
      redis.disconnect();
    }
  }
}
