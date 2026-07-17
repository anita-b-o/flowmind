import { IsOptional, IsString, MaxLength } from "class-validator";

export class CancelExecutionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
