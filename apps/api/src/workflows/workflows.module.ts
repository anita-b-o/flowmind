import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, OrganizationGuard, RolesGuard],
  exports: [WorkflowsService]
})
export class WorkflowsModule {}
