import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";
import helmet from "helmet";
import { AppModule } from "./app.module";

export interface CreateApiApplicationOptions {
  enableShutdownHooks?: boolean;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions = {}
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
    rawBody: true
  });
  app.useBodyParser("json", {
    limit: Number(process.env.WEBHOOK_PAYLOAD_MAX_BYTES ?? 1_048_576)
  });
  app.useLogger(app.get(Logger));
  if (options.enableShutdownHooks !== false) {
    app.enableShutdownHooks();
  }

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

  return app;
}
