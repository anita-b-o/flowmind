import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext, type OrganizationContext as OrganizationContextType } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ApprovalsService } from "./approvals.service";
import { DecideApprovalDto, ListApprovalsQueryDto } from "./dto/approval.dto";

@ApiTags("approvals") @ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}
  @Get() list(@OrganizationContext() org: OrganizationContextType, @Query() query: ListApprovalsQueryDto) { return this.approvals.list(org.organizationId, query); }
  @Get(":id") detail(@OrganizationContext() org: OrganizationContextType, @Param("id") id: string) { return this.approvals.detail(org.organizationId, id); }
  @Post(":id/approve") approve(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("id") id: string, @Body() dto: DecideApprovalDto) { return this.approvals.decide(org.organizationId, user.userId, id, "APPROVED", dto.comment); }
  @Post(":id/reject") reject(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("id") id: string, @Body() dto: DecideApprovalDto) { return this.approvals.decide(org.organizationId, user.userId, id, "REJECTED", dto.comment); }
}
