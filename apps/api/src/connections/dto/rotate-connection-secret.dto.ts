import { IsObject, IsOptional, IsString, MinLength } from "class-validator";

export class RotateConnectionSecretDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  secretValue?: string;

  @IsOptional()
  @IsObject()
  secretHeaders?: Record<string, string>;
}
