import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateNotificationRuleDto, ListNotificationsDto, UpdateNotificationRuleDto } from "./dto/notification.dto";
import { NotificationsService } from "./notifications.service";

@ApiTags("notification-rules") @ApiBearerAuth() @UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard) @Controller("notification-rules")
export class NotificationRulesController { constructor(private readonly service: NotificationsService) {} @Get() list(@OrganizationContext() org: OrganizationContext) { return this.service.listRules(org.organizationId); } @Post() @Roles(OrganizationRole.Editor) create(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Body() dto: CreateNotificationRuleDto) { return this.service.createRule(org.organizationId, user.userId, dto); } @Patch(":id") @Roles(OrganizationRole.Editor) update(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("id") id: string, @Body() dto: UpdateNotificationRuleDto) { return this.service.updateRule(org.organizationId, user.userId, id, dto); } @Delete(":id") @Roles(OrganizationRole.Editor) delete(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("id") id: string) { return this.service.deleteRule(org.organizationId, user.userId, id); } }

@ApiTags("notifications") @ApiBearerAuth() @UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard) @Controller("notifications")
export class NotificationsController { constructor(private readonly service: NotificationsService) {} @Get() list(@OrganizationContext() org: OrganizationContext, @Query() query: ListNotificationsDto) { return this.service.list(org.organizationId, query); } @Get(":id") detail(@OrganizationContext() org: OrganizationContext, @Param("id") id: string) { return this.service.detail(org.organizationId, id); } @Post(":id/retry") @Roles(OrganizationRole.Admin) retry(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("id") id: string) { return this.service.retry(org.organizationId, user.userId, id); } }

