import { NestFactory } from "@nestjs/core";
import { parseBaseEnv } from "@automation/config";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  parseBaseEnv(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.enableShutdownHooks();
}

void bootstrap();
