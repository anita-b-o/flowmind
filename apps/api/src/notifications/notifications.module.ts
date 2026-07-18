import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { NotificationRulesController, NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
@Module({ imports: [PrismaModule], controllers: [NotificationRulesController, NotificationsController], providers: [NotificationsService, OrganizationGuard, RolesGuard] }) export class NotificationsModule {}
