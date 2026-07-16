import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowVersionDto } from "./dto/create-workflow-version.dto";
import { WorkflowsService } from "./workflows.service";

@ApiTags("workflows")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows")
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  list(@OrganizationContext() org: OrganizationContext) {
    return this.workflowsService.list(org.organizationId);
  }

  @Post()
  @Roles(OrganizationRole.Editor)
  create(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUser,
    @Body() dto: CreateWorkflowDto
  ) {
    return this.workflowsService.create(org.organizationId, user.userId, dto);
  }

  @Post(":workflowId/versions")
  @Roles(OrganizationRole.Editor)
  createVersion(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUser,
    @Param("workflowId") workflowId: string,
    @Body() dto: CreateWorkflowVersionDto
  ) {
    return this.workflowsService.createVersion(org.organizationId, user.userId, workflowId, dto);
  }

  @Patch(":workflowId/versions/:versionId/activate")
  @Roles(OrganizationRole.Editor)
  activateVersion(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUser,
    @Param("workflowId") workflowId: string,
    @Param("versionId") versionId: string
  ) {
    return this.workflowsService.activateVersion(org.organizationId, user.userId, workflowId, versionId);
  }
}
