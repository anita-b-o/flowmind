import { IsOptional, IsString } from "class-validator";

export class CreateWebhookTriggerDto {
  @IsOptional()
  @IsString()
  name?: string;
}
