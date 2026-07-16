import { IsOptional, IsString, MaxLength } from "class-validator";

export class RetryExecutionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
