import { HealthController } from "../src/health/health.controller";
import { HealthService } from "../src/health/health.service";
import { ShutdownStateService } from "../src/runtime/shutdown-state.service";

describe("health readiness", () => {
  const redisUrl = process.env.REDIS_URL;

  afterEach(() => {
    process.env.REDIS_URL = redisUrl;
  });

  it("liveness does not query infrastructure", () => {
    const controller = new HealthController({ ready: async () => ({ status: "not_ready", checks: {} }) } as any);
    expect(controller.getLive()).toMatchObject({ status: "live", service: "api" });
  });

  it("readiness fails when database is down", async () => {
    const service = new HealthService({ $queryRaw: async () => { throw new Error("db down"); } } as any, new ShutdownStateService());
    const result = await service.ready();
    expect(result.status).toBe("not_ready");
    expect(result.checks.database).toBe("down");
  });

  it("readiness fails when redis is down", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const service = new HealthService({ $queryRaw: async () => 1 } as any, new ShutdownStateService());
    const result = await service.ready();
    expect(result.status).toBe("not_ready");
    expect(result.checks.redis).toBe("down");
  });

  it("readiness fails during shutdown", async () => {
    const shutdown = new ShutdownStateService();
    shutdown.onApplicationShutdown();
    const service = new HealthService({ $queryRaw: async () => 1 } as any, shutdown);
    const result = await service.ready();
    expect(result.status).toBe("not_ready");
    expect(result.checks.shutdown).toBe("draining");
  });
});
