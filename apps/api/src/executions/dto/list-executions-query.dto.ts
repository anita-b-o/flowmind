import { IsEnum, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { ExecutionStatus } from "@automation/shared-types";

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
  @IsEnum(ExecutionStatus)
  status?: ExecutionStatus;
}
