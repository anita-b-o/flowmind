import { Injectable } from "@nestjs/common";
import pino, { type Logger } from "pino";
import { pinoRedactPaths, sanitizeForLog } from "@automation/observability";
import { JobContextService } from "./job-context.service";

@Injectable()
export class WorkerLoggerService {
  private readonly logger: Logger;

  constructor(private readonly context: JobContextService) {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? "info",
      enabled: process.env.NODE_ENV !== "test" || process.env.LOG_LEVEL !== undefined,
      base: { service: "worker", environment: process.env.NODE_ENV ?? "development" },
      redact: process.env.LOG_REDACT_ENABLED === "false" && process.env.NODE_ENV !== "production" ? undefined : { paths: pinoRedactPaths(), censor: "[REDACTED]" },
      transport:
        (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty")) === "pretty" && process.env.NODE_ENV !== "test"
          ? { target: "pino-pretty", options: { colorize: true, singleLine: true } }
          : undefined
    });
  }

  info(event: string, fields: Record<string, unknown> = {}) {
    this.logger.info(this.fields(fields), event);
  }

  warn(event: string, fields: Record<string, unknown> = {}) {
    this.logger.warn(this.fields(fields), event);
  }

  error(event: string, fields: Record<string, unknown> = {}) {
    this.logger.error(this.fields(fields), event);
  }

  child(fields: Record<string, unknown>) {
    return this.logger.child(this.fields(fields));
  }

  private fields(fields: Record<string, unknown>) {
    const context = this.context.getContext();
    return sanitizeForLog({
      ...(context ?? {}),
      ...fields
    }) as Record<string, unknown>;
  }
}
