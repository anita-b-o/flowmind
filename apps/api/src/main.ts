import { parseBaseEnv } from "@automation/config";
import { createApiApplication } from "./bootstrap";

async function bootstrap() {
  parseBaseEnv(process.env);
  const app = await createApiApplication({ enableShutdownHooks: true });
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3001);
}

void bootstrap();
