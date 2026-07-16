import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DeadLetterExecutionsController } from "./dead-letter-executions.controller";
import { DeadLetterExecutionsService } from "./dead-letter-executions.service";

@Module({
  imports: [PrismaModule],
  controllers: [DeadLetterExecutionsController],
  providers: [DeadLetterExecutionsService]
})
export class DeadLetterExecutionsModule {}
