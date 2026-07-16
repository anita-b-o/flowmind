import { IsArray, IsIn, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
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

  @IsOptional()
  @IsIn(["legacy", "strict"])
  expressionMode?: "legacy" | "strict";

  @IsOptional()
  @IsIn([1, 2])
  workflowDefinitionSchemaVersion?: 1 | 2;

  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  workflowVariables?: Record<string, unknown>;
}
