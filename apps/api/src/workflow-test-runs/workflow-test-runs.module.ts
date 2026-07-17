import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { QueuesModule } from "../queues/queues.module";
import { RolesGuard } from "../rbac/roles.guard";
import { WorkflowTestRunsController } from "./workflow-test-runs.controller";
import { WorkflowTestRunsService } from "./workflow-test-runs.service";

@Module({
  imports: [AuditLogsModule, QueuesModule],
  controllers: [WorkflowTestRunsController],
  providers: [WorkflowTestRunsService, OrganizationGuard, RolesGuard]
})
export class WorkflowTestRunsModule {}
