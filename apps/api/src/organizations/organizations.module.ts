import { Module } from "@nestjs/common";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";
import { OrganizationGuard } from "./organization.guard";

@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, OrganizationGuard],
  exports: [OrganizationsService, OrganizationGuard]
})
export class OrganizationsModule {}
