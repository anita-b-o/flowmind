import { IsBoolean, IsEnum, IsObject, IsOptional, IsString } from "class-validator";
import type { WorkflowDefinition } from "@automation/shared-types";

export enum TestExternalModeDto {
  Mock = "mock",
  Real = "real"
}

export class CreateWorkflowTestRunDto {
  @IsOptional()
  @IsString()
  workflowVersionId?: string;

  @IsOptional()
  @IsObject()
  draftDefinition?: WorkflowDefinition;

  @IsObject()
  payload!: { trigger: Record<string, unknown>; metadata?: Record<string, unknown> };

  @IsEnum(TestExternalModeDto)
  externalMode: TestExternalModeDto = TestExternalModeDto.Mock;

  @IsOptional()
  @IsObject()
  stepMocks?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  compareWithLastReal?: boolean;

  @IsOptional()
  @IsBoolean()
  realModeConfirmed?: boolean;
}
