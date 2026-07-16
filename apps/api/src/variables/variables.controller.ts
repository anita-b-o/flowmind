import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { VariablesService } from "./variables.service";

type VariableBody = { value: unknown; description?: string };

@ApiTags("variables")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller()
export class VariablesController {
  constructor(private readonly variables: VariablesService) {}

  @Get("variables/organization")
  listOrganization(@OrganizationContext() org: OrganizationContext) {
    return this.variables.listOrganizationVariables(org.organizationId);
  }

  @Put("variables/organization/:key")
  @Roles(OrganizationRole.Editor)
  upsertOrganization(@OrganizationContext() org: OrganizationContext, @Param("key") key: string, @Body() body: VariableBody) {
    return this.variables.upsertOrganizationVariable(org.organizationId, key, body.value, body.description);
  }

  @Delete("variables/organization/:key")
  @Roles(OrganizationRole.Editor)
  async deleteOrganization(@OrganizationContext() org: OrganizationContext, @Param("key") key: string) {
    await this.variables.deleteOrganizationVariable(org.organizationId, key);
    return null;
  }

  @Get("workflows/:workflowId/variables")
  listWorkflow(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.variables.listWorkflowVariables(org.organizationId, workflowId);
  }

  @Put("workflows/:workflowId/variables/:key")
  @Roles(OrganizationRole.Editor)
  upsertWorkflow(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("key") key: string, @Body() body: VariableBody) {
    return this.variables.upsertWorkflowVariable(org.organizationId, workflowId, key, body.value, body.description);
  }

  @Delete("workflows/:workflowId/variables/:key")
  @Roles(OrganizationRole.Editor)
  async deleteWorkflow(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("key") key: string) {
    await this.variables.deleteWorkflowVariable(org.organizationId, workflowId, key);
    return null;
  }
}
