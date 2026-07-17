import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { ConnectionStatus, ConnectionType, HttpAuthScheme } from "@automation/shared-types";

export class ListConnectionsQueryDto {
  @IsOptional()
  @IsEnum(ConnectionType)
  type?: ConnectionType;

  @IsOptional()
  @IsEnum(HttpAuthScheme)
  authScheme?: HttpAuthScheme;

  @IsOptional()
  @IsEnum(ConnectionStatus)
  status?: ConnectionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
