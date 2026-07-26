import { parseBaseEnv } from "@automation/config";
import { createWorkerApplication } from "./bootstrap";

async function bootstrap() {
  parseBaseEnv(process.env);
  await createWorkerApplication({ enableShutdownHooks: true });
}

void bootstrap();
