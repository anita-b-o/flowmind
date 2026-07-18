import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Max, Min, MaxLength } from "class-validator";

export const NOTIFICATION_EVENTS = ["APPROVAL_REQUESTED", "APPROVAL_APPROVED", "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "EXECUTION_COMPLETED", "EXECUTION_FAILED", "EVENT_TRIGGER_FAILED", "EVENT_CHAIN_DEPTH_EXCEEDED"] as const;

export class CreateNotificationRuleDto {
  @IsIn(NOTIFICATION_EVENTS) eventType!: typeof NOTIFICATION_EVENTS[number];
  @IsIn(["EMAIL"]) channel: "EMAIL" = "EMAIL";
  @IsString() @MaxLength(128) connectionId!: string;
  @IsObject() recipientConfig!: Record<string, unknown>;
  @IsOptional() @IsObject() filters: Record<string, unknown> = {};
  @IsString() @MaxLength(100) templateKey!: string;
  @IsOptional() @IsBoolean() enabled = true;
}
export class UpdateNotificationRuleDto {
  @IsOptional() @IsIn(NOTIFICATION_EVENTS) eventType?: typeof NOTIFICATION_EVENTS[number];
  @IsOptional() @IsString() @MaxLength(128) connectionId?: string;
  @IsOptional() @IsObject() recipientConfig?: Record<string, unknown>;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(100) templateKey?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
export class ListNotificationsDto {
  @IsOptional() @IsIn(["PENDING", "PROCESSING", "SENT", "FAILED", "DEAD_LETTER", "CANCELLED"]) status?: string;
  @IsOptional() @IsIn(NOTIFICATION_EVENTS) type?: string;
  @IsOptional() @Type(() => Number) @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @Min(1) @Max(100) pageSize = 20;
}

