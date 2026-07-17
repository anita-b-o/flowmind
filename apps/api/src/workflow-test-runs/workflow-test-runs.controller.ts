import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { CreateWorkflowTestRunDto } from "./dto/create-workflow-test-run.dto";
import { WorkflowTestRunsService } from "./workflow-test-runs.service";

@ApiTags("workflow-test-runs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows/:workflowId/test-runs")
export class WorkflowTestRunsController {
  constructor(private readonly testRuns: WorkflowTestRunsService) {}

  @Post()
  @Roles(OrganizationRole.Editor)
  create(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Body() dto: CreateWorkflowTestRunDto
  ) {
    return this.testRuns.create(org.organizationId, user.userId, workflowId, dto);
  }

  @Get()
  list(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string) {
    return this.testRuns.list(org.organizationId, workflowId);
  }

  @Get(":testRunId")
  detail(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("testRunId") testRunId: string) {
    return this.testRuns.detail(org.organizationId, workflowId, testRunId);
  }

  @Post(":testRunId/cancel")
  @Roles(OrganizationRole.Editor)
  cancel(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("testRunId") testRunId: string
  ) {
    return this.testRuns.cancel(org.organizationId, user.userId, workflowId, testRunId);
  }

  @Post(":testRunId/rerun")
  @Roles(OrganizationRole.Editor)
  rerun(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("testRunId") testRunId: string
  ) {
    return this.testRuns.rerun(org.organizationId, user.userId, workflowId, testRunId);
  }

  @Post(":testRunId/steps/:stepKey/skip-wait")
  @Roles(OrganizationRole.Editor)
  skipWait(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Param("testRunId") testRunId: string,
    @Param("stepKey") stepKey: string
  ) {
    return this.testRuns.skipWait(org.organizationId, user.userId, workflowId, testRunId, stepKey);
  }

  @Get(":testRunId/compare-last-real")
  compare(@OrganizationContext() org: OrganizationContext, @Param("workflowId") workflowId: string, @Param("testRunId") testRunId: string) {
    return this.testRuns.compareLastReal(org.organizationId, workflowId, testRunId);
  }
}
