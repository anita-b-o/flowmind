import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { pinoRedactPaths } from "@automation/observability";
import { RequestContextMiddleware } from "./request-context.middleware";
import { RequestContextService } from "./request-context.service";
import { RequestLoggingMiddleware } from "./request-logging.middleware";
import { StructuredLoggerService } from "./structured-logger.service";

@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: false,
        level: process.env.LOG_LEVEL ?? "info",
        redact: process.env.LOG_REDACT_ENABLED === "false" && process.env.NODE_ENV !== "production" ? undefined : { paths: pinoRedactPaths(), censor: "[REDACTED]" },
        transport:
          (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty")) === "pretty" && process.env.NODE_ENV !== "test"
            ? { target: "pino-pretty", options: { colorize: true, singleLine: true } }
            : undefined
      }
    })
  ],
  providers: [RequestContextService, RequestContextMiddleware, RequestLoggingMiddleware, StructuredLoggerService],
  exports: [RequestContextService, StructuredLoggerService]
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware, RequestLoggingMiddleware).forRoutes("*");
  }
}
