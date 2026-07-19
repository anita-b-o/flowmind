import { Type } from "class-transformer";
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

export enum WorkflowTemplateStatusDto { Draft = "DRAFT", Published = "PUBLISHED", Archived = "ARCHIVED" }

export class ListWorkflowTemplatesQueryDto {
  @IsOptional() @IsEnum(WorkflowTemplateStatusDto) status?: WorkflowTemplateStatusDto;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class CreateTemplateFromWorkflowVersionDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsString() workflowId!: string;
  @IsString() workflowVersionId!: string;
}

export class CreateTemplateVersionDto {
  @IsString() workflowId!: string;
  @IsString() workflowVersionId!: string;
}

export class DependencyMappingDto {
  @IsString() dependencyKey!: string;
  @IsString() targetResourceId!: string;
  @IsOptional() @IsString() targetWorkflowVersionId?: string;
}

export class PreviewTemplateDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DependencyMappingDto)
  mappings: DependencyMappingDto[] = [];
}

export class InstantiateTemplateDto extends PreviewTemplateDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class CloneWorkflowDto extends InstantiateTemplateDto {
  @IsString() sourceWorkflowVersionId!: string;
}
