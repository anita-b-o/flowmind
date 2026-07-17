import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { PrismaModule } from "../prisma/prisma.module";
import { DataStoresController } from "./data-stores.controller";
import { DataStoresService } from "./data-stores.service";

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [DataStoresController],
  providers: [DataStoresService],
  exports: [DataStoresService]
})
export class DataStoresModule {}
