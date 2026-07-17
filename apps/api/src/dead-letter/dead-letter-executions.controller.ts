import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { DeadLetterExecutionsService } from "./dead-letter-executions.service";
import { ListDeadLetterExecutionsQueryDto } from "./dto/list-dead-letter-executions-query.dto";

@ApiTags("dead-letter-executions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("dead-letter-executions")
export class DeadLetterExecutionsController {
  constructor(private readonly service: DeadLetterExecutionsService) {}

  @Get()
  @Roles(OrganizationRole.Admin)
  list(@OrganizationContext() org: OrganizationContext, @Query() query: ListDeadLetterExecutionsQueryDto) {
    return this.service.list(org.organizationId, query);
  }

  @Get(":id")
  @Roles(OrganizationRole.Admin)
  get(@OrganizationContext() org: OrganizationContext, @Param("id") deadLetterId: string) {
    return this.service.get(org.organizationId, deadLetterId);
  }
}
