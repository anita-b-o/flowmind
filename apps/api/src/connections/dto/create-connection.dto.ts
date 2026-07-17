import { IsBoolean, IsEmail, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { ConnectionType, HttpAuthLocation, HttpAuthScheme } from "@automation/shared-types";

export class CreateConnectionDto {
  @IsEnum(ConnectionType)
  type!: ConnectionType;

  @IsOptional()
  @IsEnum(HttpAuthScheme)
  authScheme?: HttpAuthScheme;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsEnum(HttpAuthLocation)
  authLocation?: HttpAuthLocation;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  authName?: string;

  @IsOptional()
  @IsObject()
  additionalHeaders?: Record<string, string>;

  @IsOptional()
  @IsString()
  secretValue?: string;

  @IsOptional()
  @IsObject()
  secretHeaders?: Record<string, string>;

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
  password?: string;

  @IsOptional()
  @IsString()
  fromName?: string;

  @IsOptional()
  @IsEmail()
  fromEmail?: string;
}
