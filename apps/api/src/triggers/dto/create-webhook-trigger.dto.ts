import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class WebhookPayloadLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  maxBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32)
  maxDepth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxKeys?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxArrayLength?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxStringLength?: number;

  @IsOptional()
  @IsBoolean()
  requireBody?: boolean;
}

export class WebhookSignatureDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  signatureHeader?: string;

  @IsOptional()
  @IsString()
  timestampHeader?: string;

  @IsOptional()
  @IsString()
  nonceHeader?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  toleranceSeconds?: number;
}

export class CreateWebhookTriggerDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(["POST"])
  httpMethod?: "POST";

  @IsOptional()
  @IsString()
  idempotencyHeader?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookPayloadLimitsDto)
  payloadLimits?: WebhookPayloadLimitsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookSignatureDto)
  signature?: WebhookSignatureDto;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateWebhookTriggerDto extends CreateWebhookTriggerDto {}
