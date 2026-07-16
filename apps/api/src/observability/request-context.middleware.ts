import type { NextFunction, Request, Response } from "express";
import { Injectable, NestMiddleware } from "@nestjs/common";
import { traceHeaderValue, traceIdOrNew } from "@automation/observability";
import { RequestContextService } from "./request-context.service";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(request: Request, response: Response, next: NextFunction) {
    const requestHeader = process.env.REQUEST_ID_HEADER ?? "x-request-id";
    const correlationHeader = process.env.CORRELATION_ID_HEADER ?? "x-correlation-id";
    const store = {
      requestId: traceIdOrNew(traceHeaderValue(request.headers[requestHeader] as string | string[] | undefined)),
      correlationId: traceIdOrNew(traceHeaderValue(request.headers[correlationHeader] as string | string[] | undefined))
    };

    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((...args: Parameters<Response["writeHead"]>) => {
      response.setHeader(requestHeader, store.requestId);
      response.setHeader(correlationHeader, store.correlationId);
      return writeHead(...args);
    }) as Response["writeHead"];

    response.setHeader(requestHeader, store.requestId);
    response.setHeader(correlationHeader, store.correlationId);
    this.context.run(store, next);
  }
}
