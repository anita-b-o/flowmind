import { ExecutionReplayMode } from "@automation/shared-types";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export class ReplayExecutionDto {
  @IsEnum(ExecutionReplayMode)
  mode!: ExecutionReplayMode;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class ReplayPreviewQueryDto {
  @IsEnum(ExecutionReplayMode)
  mode!: ExecutionReplayMode;
}
