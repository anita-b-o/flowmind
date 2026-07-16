import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { ExpressionsService } from "./expressions.service";

@ApiTags("expressions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows/:workflowId")
export class ExpressionsController {
  constructor(private readonly expressions: ExpressionsService) {}

  @Get("variables/catalog")
  catalog(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Query("versionId") versionId?: string) {
    return this.expressions.catalog(org.organizationId, workflowId, versionId);
  }

  @Post("expressions/validate")
  @Roles(OrganizationRole.Editor)
  validate(@Body() body: { expression?: string; value?: unknown; availableStepKeys?: string[]; currentStepKey?: string }) {
    if (typeof body.expression === "string") {
      return this.expressions.validateString(body.expression, body.availableStepKeys ?? [], body.currentStepKey);
    }
    return this.expressions.validateValue(body.value, body.availableStepKeys ?? [], body.currentStepKey);
  }

  @Post("expressions/preview")
  @Roles(OrganizationRole.Editor)
  preview(@Body() body: { expression: string; sample?: unknown }) {
    return this.expressions.preview(body.expression, body.sample);
  }
}
