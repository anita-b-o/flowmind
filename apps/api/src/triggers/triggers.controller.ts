import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateWebhookTriggerDto } from "./dto/create-webhook-trigger.dto";
import { TriggersService } from "./triggers.service";

@ApiTags("triggers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows/:workflowId/triggers")
export class TriggersController {
  constructor(private readonly triggersService: TriggersService) {}

  @Post()
  @Roles(OrganizationRole.Editor)
  createWebhookTrigger(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Body() dto: CreateWebhookTriggerDto
  ) {
    return this.triggersService.createWebhookTrigger(org.organizationId, user.userId, workflowId, dto);
  }

  @Get()
  list(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.triggersService.list(org.organizationId, workflowId);
  }

  @Patch(":triggerId/rotate")
  @Roles(OrganizationRole.Editor)
  rotate(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.triggersService.rotate(org.organizationId, user.userId, workflowId, triggerId);
  }
}
