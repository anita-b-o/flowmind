import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext, type OrganizationContext as OrganizationContextType } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateTemplateFromWorkflowVersionDto, CreateTemplateVersionDto, InstantiateTemplateDto, ListWorkflowTemplatesQueryDto, PreviewTemplateDto } from "./dto/workflow-template.dto";
import { WorkflowTemplatesService } from "./workflow-templates.service";

@ApiTags("workflow-templates") @ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflow-templates")
export class WorkflowTemplatesController {
  constructor(private readonly service: WorkflowTemplatesService) {}
  @Get() list(@OrganizationContext() org: OrganizationContextType, @Query() query: ListWorkflowTemplatesQueryDto) { return this.service.list(org.organizationId, query); }
  @Post("from-workflow-version") @Roles(OrganizationRole.Editor)
  create(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Body() dto: CreateTemplateFromWorkflowVersionDto) { return this.service.createFromWorkflowVersion(org.organizationId, user.userId, dto); }
  @Get(":templateId") detail(@OrganizationContext() org: OrganizationContextType, @Param("templateId") id: string) { return this.service.detail(org.organizationId, id); }
  @Get(":templateId/versions") versions(@OrganizationContext() org: OrganizationContextType, @Param("templateId") id: string) { return this.service.versions(org.organizationId, id); }
  @Get(":templateId/versions/:versionId") version(@OrganizationContext() org: OrganizationContextType, @Param("templateId") id: string, @Param("versionId") versionId: string) { return this.service.versionDetail(org.organizationId, id, versionId); }
  @Post(":templateId/versions/from-workflow-version") @Roles(OrganizationRole.Editor)
  createVersion(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("templateId") id: string, @Body() dto: CreateTemplateVersionDto) { return this.service.createVersion(org.organizationId, user.userId, id, dto); }
  @Post(":templateId/versions/:versionId/preview") preview(@OrganizationContext() org: OrganizationContextType, @Param("templateId") id: string, @Param("versionId") versionId: string, @Body() dto: PreviewTemplateDto) { return this.service.preview(org.organizationId, id, versionId, dto); }
  @Post(":templateId/versions/:versionId/instantiate") @Roles(OrganizationRole.Editor)
  instantiate(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("templateId") id: string, @Param("versionId") versionId: string, @Body() dto: InstantiateTemplateDto) { return this.service.instantiate(org.organizationId, user.userId, id, versionId, dto); }
  @Patch(":templateId/versions/:versionId/publish") @Roles(OrganizationRole.Admin)
  publish(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("templateId") id: string, @Param("versionId") versionId: string) { return this.service.publish(org.organizationId, user.userId, id, versionId); }
  @Patch(":templateId/archive") @Roles(OrganizationRole.Admin)
  archive(@OrganizationContext() org: OrganizationContextType, @CurrentUser() user: CurrentUserType, @Param("templateId") id: string) { return this.service.archive(org.organizationId, user.userId, id); }
}
