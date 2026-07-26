import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { WorkerModule } from "./worker.module";

export interface CreateWorkerApplicationOptions {
  enableShutdownHooks?: boolean;
}

export async function createWorkerApplication(
  options: CreateWorkerApplicationOptions = {}
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true
  });
  if (options.enableShutdownHooks !== false) {
    app.enableShutdownHooks();
  }
  return app;
}
