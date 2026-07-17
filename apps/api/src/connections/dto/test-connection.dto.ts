import { IsOptional, IsString, MaxLength } from "class-validator";

export class TestConnectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}
