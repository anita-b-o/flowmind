import {
  All,
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  MethodNotAllowedException,
  Param,
  PayloadTooLargeException,
  Req,
  UnsupportedMediaTypeException,
  UseFilters
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { WebhooksService } from "./webhooks.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { WebhookRateLimitExceededException } from "./webhook-rate-limit.service";

@Catch(WebhookRateLimitExceededException)
class WebhookRateLimitExceptionFilter implements ExceptionFilter {
  catch(exception: WebhookRateLimitExceededException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .setHeader("Retry-After", String(exception.retryAfter))
      .json(exception.getResponse());
  }
}

@ApiTags("webhooks")
@Controller("webhooks")
@UseFilters(WebhookRateLimitExceptionFilter)
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly metrics: ApiMetricsService
  ) {}

  @All(":publicId/:token")
  @HttpCode(HttpStatus.ACCEPTED)
  receive(
    @Param("publicId") publicId: string,
    @Param("token") token: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() sourceIp: string,
    @Req() request: Request & { rawBody?: Buffer }
  ) {
    if (request.method.toUpperCase() !== "POST") {
      this.metrics.recordWebhook("rejected", "method_not_allowed");
      throw new MethodNotAllowedException("Webhook only supports POST");
    }
    try {
      assertJsonContentType(headers["content-type"]);
      assertPayloadSize(headers["content-length"], request.rawBody);
    } catch (error) {
      this.metrics.recordWebhook("rejected", error instanceof PayloadTooLargeException ? "payload_too_large" : "unsupported_content_type");
      throw error;
    }
    return this.webhooksService.receive({
      publicId,
      token,
      method: request.method,
      headers,
      sourceIp,
      body: request.body,
      rawBody: request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})),
      query: request.query as Record<string, unknown>
    });
  }
}

function assertJsonContentType(value: string | string[] | undefined) {
  const contentType = Array.isArray(value) ? value[0] : value;
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new UnsupportedMediaTypeException("Webhook payload must use application/json");
  }
}

function assertPayloadSize(value: string | string[] | undefined, rawBody?: Buffer) {
  const maxBytes = Number(process.env.WEBHOOK_PAYLOAD_MAX_BYTES ?? 1_048_576);
  const contentLength = Number(Array.isArray(value) ? value[0] : value);
  const actualLength = rawBody?.byteLength;
  if ((Number.isFinite(contentLength) && contentLength > maxBytes) || (actualLength !== undefined && actualLength > maxBytes)) {
    throw new PayloadTooLargeException("Webhook payload is too large");
  }
}
