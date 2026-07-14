import { IsArray, IsObject, IsString, ValidateNested } from "class-validator";
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
}

export class CreateWorkflowVersionDto {
  @IsObject()
  trigger!: WorkflowStepDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps!: WorkflowStepDto[];
}
