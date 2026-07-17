import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

class ManualExecutionInputDto {
  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateManualExecutionDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ManualExecutionInputDto)
  input?: ManualExecutionInputDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;

  @IsBoolean()
  confirmRealEffects!: boolean;
}
