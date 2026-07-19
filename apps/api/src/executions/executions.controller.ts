import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { ExecutionTimelineQueryDto } from "./dto/execution-timeline-query.dto";
import { RetryExecutionDto } from "./dto/retry-execution.dto";
import { ReplayExecutionDto, ReplayPreviewQueryDto } from "./dto/replay-execution.dto";
import { CancelExecutionDto } from "./dto/cancel-execution.dto";
import { CreateManualExecutionDto } from "./dto/create-manual-execution.dto";
import { ExecutionsService } from "./executions.service";
import { Roles } from "../rbac/roles.decorator";

@ApiTags("executions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("executions")
export class ExecutionsController {
  constructor(private readonly executionsService: ExecutionsService) {}

  @Get()
  @Roles(OrganizationRole.Viewer)
  list(@OrganizationContext() org: OrganizationContext, @Query() query: ListExecutionsQueryDto) {
    return this.executionsService.list(org.organizationId, query);
  }

  @Get(":executionId")
  @Roles(OrganizationRole.Viewer)
  getDetail(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string) {
    return this.executionsService.getDetail(org.organizationId, executionId);
  }

  @Get(":executionId/timeline")
  @Roles(OrganizationRole.Viewer)
  timeline(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string, @Query() query: ExecutionTimelineQueryDto) {
    return this.executionsService.timeline(org.organizationId, executionId, query);
  }

  @Get(":executionId/tree")
  @Roles(OrganizationRole.Viewer)
  tree(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string) {
    return this.executionsService.tree(org.organizationId, executionId);
  }

  @Get(":executionId/steps/:stepExecutionId")
  @Roles(OrganizationRole.Viewer)
  stepDetail(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string, @Param("stepExecutionId") stepExecutionId: string) {
    return this.executionsService.stepDetail(org.organizationId, executionId, stepExecutionId);
  }

  @Post(":executionId/retry")
  @Roles(OrganizationRole.Editor)
  retry(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("executionId") executionId: string,
    @Body() dto: RetryExecutionDto,
    @Headers("idempotency-key") idempotencyKey?: string
  ) {
    return this.executionsService.retry(org.organizationId, user.userId, executionId, dto.reason, idempotencyKey ?? dto.idempotencyKey);
  }

  @Get(":executionId/replay-preview")
  @Roles(OrganizationRole.Viewer)
  replayPreview(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string, @Query() query: ReplayPreviewQueryDto) {
    return this.executionsService.replayPreview(org.organizationId, executionId, query.mode);
  }

  @Post(":executionId/replay")
  @Roles(OrganizationRole.Editor)
  replay(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("executionId") executionId: string, @Body() dto: ReplayExecutionDto, @Headers("idempotency-key") idempotencyKey?: string) {
    return this.executionsService.replay(org.organizationId, user.userId, executionId, dto.mode, dto.reason, idempotencyKey);
  }

  @Post(":executionId/cancel")
  @Roles(OrganizationRole.Editor)
  cancel(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("executionId") executionId: string,
    @Body() dto: CancelExecutionDto
  ) {
    return this.executionsService.cancel(org.organizationId, user.userId, executionId, dto.reason);
  }
}

@ApiTags("executions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("workflows/:workflowId/executions")
export class WorkflowExecutionsController {
  constructor(private readonly executionsService: ExecutionsService) {}

  @Post()
  @Roles(OrganizationRole.Editor)
  createManual(
    @OrganizationContext() org: OrganizationContext,
    @CurrentUser() user: CurrentUserType,
    @Param("workflowId") workflowId: string,
    @Body() dto: CreateManualExecutionDto,
    @Headers("idempotency-key") idempotencyKey?: string
  ) {
    return this.executionsService.createManual(org.organizationId, user.userId, workflowId, dto, idempotencyKey);
  }
}
