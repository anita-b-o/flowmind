import { IsString, MinLength } from "class-validator";

export class RotateConnectionSecretDto {
  @IsString()
  @MinLength(1)
  secretValue!: string;
}
