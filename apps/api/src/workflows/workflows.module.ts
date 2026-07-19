import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { ExpressionsModule } from "../expressions/expressions.module";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowTemplatesService } from "../workflow-templates/workflow-templates.service";

@Module({
  imports: [AuditLogsModule, ExpressionsModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowTemplatesService, OrganizationGuard, RolesGuard],
  exports: [WorkflowsService, WorkflowTemplatesService]
})
export class WorkflowsModule {}
