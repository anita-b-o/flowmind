import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

class WorkflowStepDto {
  @IsString()
  key!: string;

  @IsString()
  name!: string;

  @IsString()
  type!: string;

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  retryPolicy?: Record<string, unknown>;

  @IsOptional()
  timeoutSeconds?: number;
}

export class CreateWorkflowVersionDto {
  @IsObject()
  trigger!: WorkflowStepDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps!: WorkflowStepDto[];
}
