import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsController } from "./audit-logs.controller";
import { AuditLogsService } from "./audit-logs.service";

@Module({
  imports: [PrismaModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService, OrganizationGuard, RolesGuard],
  exports: [AuditLogsService]
})
export class AuditLogsModule {}
