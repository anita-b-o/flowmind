import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";
import { QueueService } from "./queue.service";

@Module({
  imports: [
    BullModule.registerQueue({
      name: WORKFLOW_EXECUTIONS_QUEUE
    })
  ],
  providers: [QueueService],
  exports: [QueueService]
})
export class QueuesModule {}
