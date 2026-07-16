import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { DeadLetterExecutionsService } from "./dead-letter-executions.service";

@ApiTags("dead-letter-executions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("dead-letter-executions")
export class DeadLetterExecutionsController {
  constructor(private readonly service: DeadLetterExecutionsService) {}

  @Get()
  @Roles(OrganizationRole.Viewer)
  list(@OrganizationContext() org: OrganizationContext, @Query() query: { page?: number; pageSize?: number }) {
    return this.service.list(org.organizationId, query);
  }

  @Get(":id")
  @Roles(OrganizationRole.Viewer)
  get(@OrganizationContext() org: OrganizationContext, @Param("id") id: string) {
    return this.service.get(org.organizationId, id);
  }
}
