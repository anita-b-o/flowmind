import "reflect-metadata";
import { parseBaseEnv } from "@automation/config";
import {
  createApiApplication,
  EmbeddedWorkerHealthBridge,
  ScheduledTriggersProcessor,
  ShutdownStateService as ApiShutdownStateService
} from "@automation/api";
import {
  createWorkerApplication,
  ShutdownStateService as WorkerShutdownStateService,
  WorkerHealthService
} from "@automation/worker";

export async function bootstrapDemoRuntime(): Promise<void> {
  if (process.env.FLOWMIND_DEPLOYMENT_PROFILE !== "demo-free") {
    throw new Error(
      "apps/demo-runtime only accepts FLOWMIND_DEPLOYMENT_PROFILE=demo-free"
    );
  }
  parseBaseEnv(process.env);

  const api = await createApiApplication({ enableShutdownHooks: false });
  let worker: Awaited<ReturnType<typeof createWorkerApplication>> | undefined;

  try {
    const workerApp = await createWorkerApplication({ enableShutdownHooks: false });
    worker = workerApp;
    const bridge = api.get(EmbeddedWorkerHealthBridge);
    const workerHealth = workerApp.get(WorkerHealthService);
    const scheduledTriggers = api.get(ScheduledTriggersProcessor);
    bridge.attach(async () => {
      const health = await workerHealth.ready();
      return {
        status:
          health.status === "ready" && scheduledTriggers.isRunning()
            ? "ready"
            : "not_ready",
        checks: {
          ...health.checks,
          scheduledTriggerProcessor: scheduledTriggers.isRunning() ? "up" : "down"
        }
      };
    });

    const port = process.env.PORT ? Number(process.env.PORT) : 3001;
    await api.listen(port);

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shutdownPromise) return;
      api.get(ApiShutdownStateService).beginShutdown();
      bridge.beginShutdown();
      workerApp.get(WorkerShutdownStateService).beginShutdown();
      shutdownPromise = closeRuntime(api, workerApp, signal).catch((error) => {
        console.error("demo-runtime.shutdown.failed", {
          signal,
          error: error instanceof Error ? error.message : String(error)
        });
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    await api.close().catch(() => undefined);
    await worker?.close().catch(() => undefined);
    throw error;
  }
}

async function closeRuntime(
  api: Awaited<ReturnType<typeof createApiApplication>>,
  worker: Awaited<ReturnType<typeof createWorkerApplication>>,
  signal: NodeJS.Signals
) {
  const timeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 20_000);
  console.info("demo-runtime.shutdown.started", { signal, timeoutMs });
  await withTimeout(
    (async () => {
      await Promise.all([api.close(), worker.close()]);
    })(),
    timeoutMs
  );
  console.info("demo-runtime.shutdown.completed", { signal });
}

async function withTimeout(promise: Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Demo runtime shutdown exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (require.main === module) {
  void bootstrapDemoRuntime().catch((error) => {
    console.error("demo-runtime.bootstrap.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  });
}
