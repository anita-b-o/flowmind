import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { ExpressionsModule } from "../expressions/expressions.module";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
  imports: [AuditLogsModule, ExpressionsModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, OrganizationGuard, RolesGuard],
  exports: [WorkflowsService]
})
export class WorkflowsModule {}
