import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { QueuesModule } from "../queues/queues.module";
import { ExecutionsController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({
  imports: [QueuesModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService, OrganizationGuard, RolesGuard]
})
export class ExecutionsModule {}
