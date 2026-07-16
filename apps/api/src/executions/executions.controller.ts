import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { RetryExecutionDto } from "./dto/retry-execution.dto";
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
    @Body() dto: RetryExecutionDto
  ) {
    return this.executionsService.retry(org.organizationId, user.userId, executionId, dto.reason);
  }
}
