import { IsBoolean, IsDefined, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";

export class CreateDataStoreDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateDataStoreDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListDataStoreRecordsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class UpsertDataStoreRecordDto {
  @IsDefined() value!: unknown;
  @IsOptional() metadata?: Record<string, unknown>;
  @IsOptional() ttlSeconds?: number;
  @IsOptional() @IsIn(["replace", "merge"]) mode?: "replace" | "merge";
  @IsOptional() @IsBoolean() optimisticConcurrency?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
}
