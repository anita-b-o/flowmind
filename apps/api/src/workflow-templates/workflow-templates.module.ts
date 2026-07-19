import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { WorkflowsModule } from "../workflows/workflows.module";
import { WorkflowTemplatesController } from "./workflow-templates.controller";

@Module({ imports: [AuditLogsModule, WorkflowsModule], controllers: [WorkflowTemplatesController], providers: [OrganizationGuard, RolesGuard] })
export class WorkflowTemplatesModule {}
