import { IsOptional, IsString } from "class-validator";

export class TestConnectionDto {
  @IsOptional()
  @IsString()
  url?: string;
}
