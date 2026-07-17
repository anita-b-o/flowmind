import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateWebhookTriggerDto, UpdateWebhookTriggerDto } from "./dto/create-webhook-trigger.dto";
import { CreateScheduledTriggerDto, PreviewScheduledTriggerDto, UpdateScheduledTriggerDto } from "./dto/scheduled-trigger.dto";
import { ScheduledTriggersService } from "./scheduled-triggers.service";
import { TriggersService } from "./triggers.service";

@ApiTags("triggers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows/:workflowId/triggers")
export class TriggersController {
  constructor(
    private readonly triggersService: TriggersService,
    private readonly scheduledTriggersService: ScheduledTriggersService
  ) {}

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

  @Post("scheduled")
  @Roles(OrganizationRole.Editor)
  createScheduledTrigger(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Body() dto: CreateScheduledTriggerDto
  ) {
    return this.scheduledTriggersService.create(org.organizationId, user.userId, workflowId, dto);
  }

  @Post("scheduled/preview")
  @Roles(OrganizationRole.Editor)
  previewScheduledTrigger(@Body() dto: PreviewScheduledTriggerDto) {
    return this.scheduledTriggersService.preview(dto);
  }

  @Get()
  list(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.triggersService.list(org.organizationId, workflowId);
  }

  @Get("scheduled")
  listScheduled(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.scheduledTriggersService.list(org.organizationId, workflowId);
  }

  @Get(":triggerId")
  get(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("triggerId") triggerId: string) {
    return this.getTrigger(org.organizationId, workflowId, triggerId);
  }

  @Patch(":triggerId/scheduled")
  @Roles(OrganizationRole.Editor)
  updateScheduled(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string,
    @Body() dto: UpdateScheduledTriggerDto
  ) {
    return this.scheduledTriggersService.update(org.organizationId, user.userId, workflowId, triggerId, dto);
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
    return this.setEnabled(org.organizationId, user.userId, workflowId, triggerId, true);
  }

  @Patch(":triggerId/disable")
  @Roles(OrganizationRole.Editor)
  disable(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.setEnabled(org.organizationId, user.userId, workflowId, triggerId, false);
  }

  @Patch(":triggerId/pause")
  @Roles(OrganizationRole.Editor)
  pause(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.scheduledTriggersService.setPaused(org.organizationId, user.userId, workflowId, triggerId, true);
  }

  @Patch(":triggerId/resume")
  @Roles(OrganizationRole.Editor)
  resume(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("triggerId") triggerId: string
  ) {
    return this.scheduledTriggersService.setPaused(org.organizationId, user.userId, workflowId, triggerId, false);
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
    return this.deleteTrigger(org.organizationId, user.userId, workflowId, triggerId);
  }

  private async setEnabled(organizationId: string, userId: string, workflowId: string, triggerId: string, enabled: boolean) {
    try {
      return await this.scheduledTriggersService.setEnabled(organizationId, userId, workflowId, triggerId, enabled);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      return this.triggersService.setEnabled(organizationId, userId, workflowId, triggerId, enabled);
    }
  }

  private async getTrigger(organizationId: string, workflowId: string, triggerId: string) {
    try {
      return await this.scheduledTriggersService.get(organizationId, workflowId, triggerId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      return this.triggersService.get(organizationId, workflowId, triggerId);
    }
  }

  private async deleteTrigger(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    try {
      return await this.scheduledTriggersService.delete(organizationId, userId, workflowId, triggerId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      return this.triggersService.delete(organizationId, userId, workflowId, triggerId);
    }
  }
}
