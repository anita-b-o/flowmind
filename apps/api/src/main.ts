import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";
import helmet from "helmet";
import { parseBaseEnv } from "@automation/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  parseBaseEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false, rawBody: true });
  app.useBodyParser("json", { limit: Number(process.env.WEBHOOK_PAYLOAD_MAX_BYTES ?? 1_048_576) });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
    credentials: true
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  if (process.env.NODE_ENV !== "production" || process.env.API_DOCS_ENABLED === "true") {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Automation Platform API")
      .setDescription("Multi-tenant workflow automation API")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3001);
}

void bootstrap();
