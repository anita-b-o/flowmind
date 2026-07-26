import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { EmbeddedWorkerHealthBridge } from "./embedded-worker-health.bridge";

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [HealthService, ShutdownStateService, EmbeddedWorkerHealthBridge],
  exports: [ShutdownStateService, EmbeddedWorkerHealthBridge]
})
export class HealthModule {}
