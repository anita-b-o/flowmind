import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { RetryExecutionDto } from "./dto/retry-execution.dto";
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
  list(@OrganizationContext() org: OrganizationContext, @Query() query: ListExecutionsQueryDto) {
    return this.executionsService.list(org.organizationId, query);
  }

  @Get(":executionId")
  getDetail(@OrganizationContext() org: OrganizationContext, @Param("executionId") executionId: string) {
    return this.executionsService.getDetail(org.organizationId, executionId);
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
