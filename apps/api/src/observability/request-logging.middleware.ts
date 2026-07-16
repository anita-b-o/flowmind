import type { NextFunction, Request, Response } from "express";
import { Injectable, NestMiddleware } from "@nestjs/common";
import { sanitizeError } from "@automation/observability";
import { RequestContextService } from "./request-context.service";
import { StructuredLoggerService } from "./structured-logger.service";

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContextService,
    private readonly logger: StructuredLoggerService
  ) {}

  use(request: Request, response: Response, next: NextFunction) {
    if (isQuietHealth(request.path)) {
      next();
      return;
    }
    const started = Date.now();
    this.logger.info("api.request.received", {
      method: request.method,
      route: routeName(request),
      path: request.path
    });
    response.on("finish", () => {
      this.logger.info(response.statusCode >= 500 ? "api.request.failed" : "api.request.completed", {
        method: request.method,
        route: routeName(request),
        status: response.statusCode,
        durationMs: Date.now() - started
      });
    });
    response.on("error", (error) => {
      this.logger.error("api.request.failed", {
        method: request.method,
        route: routeName(request),
        durationMs: Date.now() - started,
        error: sanitizeError(error)
      });
    });
    next();
  }
}

function routeName(request: Request) {
  return request.route?.path ? `${request.baseUrl}${request.route.path}` : request.path;
}

function isQuietHealth(path: string) {
  return path === "/health/live" || path === "/health/ready";
}
