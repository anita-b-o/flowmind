import { IsEmail, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
  @IsString()
  authName?: string;

  @IsOptional()
  @IsObject()
  additionalHeaders?: Record<string, string>;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  port?: number;

  @IsOptional()
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
