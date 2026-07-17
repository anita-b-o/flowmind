import { IsBoolean, IsEmail, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { HttpAuthLocation, HttpAuthScheme } from "@automation/shared-types";

export class UpdateConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsEnum(HttpAuthScheme)
  authScheme?: HttpAuthScheme;

  @IsOptional()
  @IsEnum(HttpAuthLocation)
  authLocation?: HttpAuthLocation;

  @IsOptional()
  @IsString()
  authName?: string;

  @IsOptional()
  @IsObject()
  additionalHeaders?: Record<string, string>;

  @IsOptional()
  @IsObject()
  secretHeaders?: Record<string, string>;

  @IsOptional()
  @IsString()
  secretValue?: string;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  fromName?: string;

  @IsOptional()
  @IsEmail()
  fromEmail?: string;
}
