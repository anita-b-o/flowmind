import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ConnectionsService } from "./connections.service";
import { CreateConnectionDto } from "./dto/create-connection.dto";
import { RotateConnectionSecretDto } from "./dto/rotate-connection-secret.dto";
import { TestConnectionDto } from "./dto/test-connection.dto";
import { UpdateConnectionDto } from "./dto/update-connection.dto";

@ApiTags("connections")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType) {
    return this.connections.list(org.organizationId, user.userId);
  }

  @Post()
  create(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Body() dto: CreateConnectionDto) {
    return this.connections.create(org.organizationId, user.userId, dto);
  }

  @Get(":connectionId")
  detail(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("connectionId") connectionId: string) {
    return this.connections.detail(org.organizationId, user.userId, connectionId);
  }

  @Patch(":connectionId")
  update(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("connectionId") connectionId: string,
    @Body() dto: UpdateConnectionDto
  ) {
    return this.connections.update(org.organizationId, user.userId, connectionId, dto);
  }

  @Post(":connectionId/rotate")
  rotate(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("connectionId") connectionId: string,
    @Body() dto: RotateConnectionSecretDto
  ) {
    return this.connections.rotate(org.organizationId, user.userId, connectionId, dto);
  }

  @Post(":connectionId/revoke")
  revoke(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("connectionId") connectionId: string) {
    return this.connections.revoke(org.organizationId, user.userId, connectionId);
  }

  @Delete(":connectionId")
  delete(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("connectionId") connectionId: string) {
    return this.connections.delete(org.organizationId, user.userId, connectionId);
  }

  @Post(":connectionId/test")
  test(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("connectionId") connectionId: string,
    @Body() dto: TestConnectionDto
  ) {
    return this.connections.test(org.organizationId, user.userId, connectionId, dto);
  }
}
