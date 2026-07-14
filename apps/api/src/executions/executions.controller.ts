import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { ExecutionsService } from "./executions.service";

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
}
