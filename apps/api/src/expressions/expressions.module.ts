import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ExpressionsController } from "./expressions.controller";
import { ExpressionsService } from "./expressions.service";

@Module({
  controllers: [ExpressionsController],
  providers: [ExpressionsService, OrganizationGuard, RolesGuard],
  exports: [ExpressionsService]
})
export class ExpressionsModule {}
