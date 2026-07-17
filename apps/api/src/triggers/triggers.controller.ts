import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateWebhookTriggerDto, UpdateWebhookTriggerDto } from "./dto/create-webhook-trigger.dto";
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

  @Get(":triggerId")
  get(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("triggerId") triggerId: string) {
    return this.triggersService.get(org.organizationId, workflowId, triggerId);
  }

  @Patch(":triggerId")
  @Roles(OrganizationRole.Editor)
  update(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string,
    @Body() dto: UpdateWebhookTriggerDto
  ) {
    return this.triggersService.update(org.organizationId, user.userId, workflowId, triggerId, dto);
  }

  @Patch(":triggerId/enable")
  @Roles(OrganizationRole.Editor)
  enable(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.triggersService.setEnabled(org.organizationId, user.userId, workflowId, triggerId, true);
  }

  @Patch(":triggerId/disable")
  @Roles(OrganizationRole.Editor)
  disable(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.triggersService.setEnabled(org.organizationId, user.userId, workflowId, triggerId, false);
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

  @Delete(":triggerId")
  @Roles(OrganizationRole.Editor)
  delete(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.triggersService.delete(org.organizationId, user.userId, workflowId, triggerId);
  }
}
