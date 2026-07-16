import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [HealthService, ShutdownStateService],
  exports: [ShutdownStateService]
})
export class HealthModule {}
