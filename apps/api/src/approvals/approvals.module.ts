import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { PrismaModule } from "../prisma/prisma.module";
import { QueuesModule } from "../queues/queues.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

@Module({ imports: [PrismaModule, QueuesModule, MetricsModule], controllers: [ApprovalsController], providers: [ApprovalsService, OrganizationGuard, RolesGuard], exports: [ApprovalsService] })
export class ApprovalsModule {}
