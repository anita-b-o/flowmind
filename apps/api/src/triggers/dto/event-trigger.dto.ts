import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { INTERNAL_EVENT_TYPES, type InternalEventType } from "@automation/shared-types";

export class CreateEventTriggerDto {
  @IsString() @MaxLength(80) name!: string;
  @IsIn(INTERNAL_EVENT_TYPES) eventType!: InternalEventType;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateEventTriggerDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(INTERNAL_EVENT_TYPES) eventType?: InternalEventType;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
}

export class ListEventTriggersDto {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
