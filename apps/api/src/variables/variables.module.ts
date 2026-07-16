import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { VariablesController } from "./variables.controller";
import { VariablesService } from "./variables.service";

@Module({
  controllers: [VariablesController],
  providers: [VariablesService, OrganizationGuard, RolesGuard],
  exports: [VariablesService]
})
export class VariablesModule {}
