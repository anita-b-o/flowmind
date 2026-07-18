import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { APPROVAL_LIMITS } from "@automation/shared-types";

export class ListApprovalsQueryDto {
  @IsOptional() @IsIn(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]) status?: string;
  @IsOptional() @IsUUID() workflowId?: string;
  @IsOptional() @IsUUID() executionId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsInt() @Min(1) page = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class DecideApprovalDto {
  @IsOptional() @IsString() @MaxLength(APPROVAL_LIMITS.decisionComment) comment?: string;
}
