import type { NextFunction, Request, Response } from "express";
import { Injectable, NestMiddleware } from "@nestjs/common";
import { ApiMetricsService } from "./metrics.service";
import { classifyError, HTTP_ROUTES_EXCLUDED, normalizeRoute, statusClass } from "./metrics-catalog";

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: ApiMetricsService) {}

  use(request: Request, response: Response, next: NextFunction) {
    if (!this.metrics.enabled() || HTTP_ROUTES_EXCLUDED.has(request.path)) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    let observed = false;

    const observe = (error?: unknown) => {
      if (observed) return;
      observed = true;
      const route = routeName(request);
      const labels = {
        method: request.method,
        route,
        status_class: statusClass(response.statusCode || 500)
      };
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, durationSeconds);
      if (response.statusCode >= 500 || error) {
        this.metrics.httpErrors.inc({ ...labels, error_category: classifyError(error) });
      }
    };

    response.on("finish", () => observe());
    response.on("error", (error) => observe(error));
    next();
  }
}

function routeName(request: Request) {
  return request.route?.path ? `${request.baseUrl}${request.route.path}` : normalizeRoute(request.path, request.method);
}
