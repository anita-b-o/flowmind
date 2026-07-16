import { Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    private readonly logger?: StructuredLoggerService
  ) {}

  async ready() {
    const checks: Record<string, string> = {};
    checks.config = process.env.DATABASE_URL && process.env.REDIS_URL && process.env.JWT_ACCESS_SECRET ? "valid" : "invalid";
    checks.shutdown = this.shutdown.isShuttingDown() ? "draining" : "ok";
    checks.database = await this.checkDatabase();
    checks.redis = await this.checkRedis();
    const ready = Object.values(checks).every((value) => ["up", "valid", "ok"].includes(value));
    if (!ready) {
      this.logger?.warn("api.health.readiness_failed", { checks });
    }
    return { status: ready ? "ready" : "not_ready", checks };
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
