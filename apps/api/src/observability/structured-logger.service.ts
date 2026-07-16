import { Injectable } from "@nestjs/common";
import pino, { type Logger } from "pino";
import { pinoRedactPaths, sanitizeForLog } from "@automation/observability";
import { RequestContextService } from "./request-context.service";

@Injectable()
export class StructuredLoggerService {
  private readonly logger: Logger;

  constructor(private readonly context: RequestContextService) {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? "info",
      enabled: process.env.NODE_ENV !== "test" || process.env.LOG_LEVEL !== undefined,
      base: { service: "api", environment: process.env.NODE_ENV ?? "development" },
      redact: redactionEnabled() ? { paths: pinoRedactPaths(), censor: "[REDACTED]" } : undefined,
      transport: logFormat() === "pretty" ? { target: "pino-pretty", options: { colorize: true, singleLine: true } } : undefined
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
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context?.userId ? { userId: context.userId } : {}),
      ...(context?.organizationId ? { organizationId: context.organizationId } : {}),
      ...fields
    }) as Record<string, unknown>;
  }
}

function logFormat() {
  return process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty");
}

function redactionEnabled() {
  return process.env.NODE_ENV === "production" || process.env.LOG_REDACT_ENABLED !== "false";
}
