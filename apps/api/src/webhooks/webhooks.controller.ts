import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  PayloadTooLargeException,
  Post,
  UnsupportedMediaTypeException
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { WebhooksService } from "./webhooks.service";

@ApiTags("webhooks")
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post(":workflowId/:token")
  @HttpCode(HttpStatus.ACCEPTED)
  receive(
    @Param("workflowId") workflowId: string,
    @Param("token") token: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() sourceIp: string,
    @Body() body: unknown
  ) {
    assertJsonContentType(headers["content-type"]);
    assertPayloadSize(headers["content-length"]);
    return this.webhooksService.receive({ workflowId, token, headers, sourceIp, body });
  }
}

function assertJsonContentType(value: string | string[] | undefined) {
  const contentType = Array.isArray(value) ? value[0] : value;
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new UnsupportedMediaTypeException("Webhook payload must use application/json");
  }
}

function assertPayloadSize(value: string | string[] | undefined) {
  const maxBytes = Number(process.env.WEBHOOK_PAYLOAD_MAX_BYTES ?? 1_048_576);
  const contentLength = Number(Array.isArray(value) ? value[0] : value);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadTooLargeException("Webhook payload is too large");
  }
}
