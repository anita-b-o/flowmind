import { Type } from "class-transformer";
import { IsIn, IsISO8601, IsOptional, IsString, Max, Min } from "class-validator";
import { PUBLIC_DEAD_LETTER_REASONS, type PublicDeadLetterReason } from "../dead-letter-reasons";

export class ListDeadLetterExecutionsQueryDto {
  @IsOptional()
  @IsIn(["active", "resolved"])
  status?: "active" | "resolved";

  @IsOptional()
  @IsString()
  workflowId?: string;

  @IsOptional()
  @IsIn(PUBLIC_DEAD_LETTER_REASONS)
  reason?: PublicDeadLetterReason;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  pageSize = 20;
}
