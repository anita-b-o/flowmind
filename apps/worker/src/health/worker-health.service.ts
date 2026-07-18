import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { ExecutionReconcilerService } from "../recovery/execution-reconciler.service";
import { EventDispatcherService } from "../internal-events/event-dispatcher.service";

@Injectable()
export class WorkerHealthService implements OnModuleInit, OnModuleDestroy {
  private server?: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    private readonly reconciler: ExecutionReconcilerService,
    private readonly eventDispatcher: EventDispatcherService
  ) {}

  onModuleInit() {
    if (!process.env.WORKER_HEALTH_PORT) {
      return;
    }
    const port = Number(process.env.WORKER_HEALTH_PORT);
    if (port === 0) return;
    this.server = createServer(async (request, response) => {
      if (request.url === "/health/live") {
        write(response, 200, { status: "live", service: "worker" });
        return;
      }
      if (request.url === "/health/ready") {
        const result = await this.ready();
        write(response, result.status === "ready" ? 200 : 503, result);
        return;
      }
      write(response, 404, { status: "not_found" });
    });
    this.server.on("error", (error) => {
      console.warn("Worker health server failed", { message: error.message });
    });
    this.server.listen(port);
    this.server.unref();
  }

  async onModuleDestroy() {
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  private async ready() {
    const checks: Record<string, string> = {
      shutdown: this.shutdown.isShuttingDown() ? "draining" : "ok",
      reconciler: this.reconciler.isActive() ? "up" : "down"
      ,eventDispatcher: this.eventDispatcher.isActive() ? "up" : "down"
    };
    checks.database = await this.checkDatabase();
    checks.redis = await this.checkRedis();
    const ready = Object.values(checks).every((value) => ["up", "ok"].includes(value));
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

function write(response: any, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
