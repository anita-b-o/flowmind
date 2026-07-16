import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsService } from "./audit-logs.service";
import { ListAuditLogsQueryDto } from "./dto/list-audit-logs-query.dto";

@ApiTags("audit-logs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @Roles(OrganizationRole.Admin)
  list(@OrganizationContext() org: OrganizationContext, @Query() query: ListAuditLogsQueryDto) {
    return this.auditLogs.list(org.organizationId, query);
  }
}
