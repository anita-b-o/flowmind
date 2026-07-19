import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
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
import { ListWorkflowVersionsQueryDto } from "./dto/list-workflow-versions-query.dto";
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

  @Get("invocable")
  @Roles(OrganizationRole.Editor)
  listInvocable(@OrganizationContext() org: OrganizationContext) {
    return this.workflowsService.listInvocable(org.organizationId);
  }

  @Get(":workflowId")
  detail(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.workflowsService.detail(org.organizationId, workflowId);
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

  @Get(":workflowId/versions")
  listVersions(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Query() query: ListWorkflowVersionsQueryDto) {
    return this.workflowsService.listVersions(org.organizationId, workflowId, query);
  }

  @Get(":workflowId/versions/:versionId")
  versionDetail(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("versionId") versionId: string) {
    return this.workflowsService.versionDetail(org.organizationId, workflowId, versionId);
  }

  @Get(":workflowId/versions/:versionId/diff/:otherVersionId")
  diffVersions(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("versionId") versionId: string, @Param("otherVersionId") otherVersionId: string) {
    return this.workflowsService.diffVersions(org.organizationId, workflowId, versionId, otherVersionId);
  }

  @Get(":workflowId/versions/:versionId/restore-preview")
  restorePreview(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("versionId") versionId: string) {
    return this.workflowsService.restorePreview(org.organizationId, workflowId, versionId);
  }

  @Post(":workflowId/versions/:versionId/restore")
  @Roles(OrganizationRole.Editor)
  restore(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUser, @Param("workflowId") workflowId: string, @Param("versionId") versionId: string) {
    return this.workflowsService.restoreVersion(org.organizationId, user.userId, workflowId, versionId);
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
