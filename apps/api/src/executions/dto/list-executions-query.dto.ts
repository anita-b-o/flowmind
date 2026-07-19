import { IsBooleanString, IsISO8601, IsIn, IsOptional, IsString, Max, Min } from "class-validator";
import { Transform, Type } from "class-transformer";

export class ListExecutionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @IsString()
  workflowId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Transform(({ value }) => Array.isArray(value) ? value : String(value).split(",").filter(Boolean))
  statuses?: string[];

  @IsOptional()
  @IsIn(["manual", "webhook", "scheduled", "event", "subworkflow", "retry"])
  triggerType?: string;

  @IsOptional()
  @IsIn(["root", "child", "all"])
  relationship?: "root" | "child" | "all";

  @IsOptional()
  @IsBooleanString()
  waiting?: string;

  @IsOptional()
  @IsBooleanString()
  failed?: string;

  @IsOptional()
  @IsString()
  failedStepKey?: string;

  @IsOptional()
  @IsString()
  rootExecutionId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
