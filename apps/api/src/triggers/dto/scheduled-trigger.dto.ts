import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateScheduledTriggerDto {
  @IsString()
  @MaxLength(120)
  cron!: string;

  @IsString()
  @MaxLength(120)
  timezone!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @IsIn(["skip_if_running"])
  executionPolicy?: "skip_if_running";

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateScheduledTriggerDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cron?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  timezone?: string;

  @IsOptional()
  @IsIn(["skip_if_running"])
  executionPolicy?: "skip_if_running";

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class PreviewScheduledTriggerDto {
  @IsString()
  @MaxLength(120)
  cron!: string;

  @IsString()
  @MaxLength(120)
  timezone!: string;
}
