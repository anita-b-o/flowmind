import { Injectable, OnModuleInit } from "@nestjs/common";
import { StepType } from "@automation/shared-types";
import { StepHandler } from "./types";
import { AiHandler } from "./handlers/ai.handler";
import { ConditionalHandler } from "./handlers/conditional.handler";
import { DatabaseRecordHandler } from "./handlers/database-record.handler";
import { EmailNotificationHandler } from "./handlers/email-notification.handler";
import { HttpRequestHandler } from "./handlers/http-request.handler";
import { IfHandler } from "./handlers/if.handler";
import { SwitchHandler } from "./handlers/switch.handler";
import { DelayHandler } from "./handlers/delay.handler";
import { WaitUntilHandler } from "./handlers/wait-until.handler";
import { TransformHandler } from "./handlers/transform.handler";
import { DataStoreGetRecordHandler } from "./handlers/data-store/get-record.handler";
import { DataStoreUpsertRecordHandler } from "./handlers/data-store/upsert-record.handler";
import { DataStoreDeleteRecordHandler } from "./handlers/data-store/delete-record.handler";
import { DataStoreExistsRecordHandler } from "./handlers/data-store/exists-record.handler";
import { DataStoreCountRecordsHandler } from "./handlers/data-store/count-records.handler";
import { DataStoreListRecordsHandler } from "./handlers/data-store/list-records.handler";

@Injectable()
export class StepRegistry implements OnModuleInit {
  private readonly handlers = new Map<StepType, StepHandler>();

  constructor(
    private readonly httpRequestHandler: HttpRequestHandler,
    private readonly conditionalHandler: ConditionalHandler,
    private readonly ifHandler: IfHandler,
    private readonly switchHandler: SwitchHandler,
    private readonly delayHandler: DelayHandler,
    private readonly waitUntilHandler: WaitUntilHandler,
    private readonly transformHandler: TransformHandler,
    private readonly databaseRecordHandler: DatabaseRecordHandler,
    private readonly dataStoreGetRecordHandler: DataStoreGetRecordHandler,
    private readonly dataStoreUpsertRecordHandler: DataStoreUpsertRecordHandler,
    private readonly dataStoreDeleteRecordHandler: DataStoreDeleteRecordHandler,
    private readonly dataStoreExistsRecordHandler: DataStoreExistsRecordHandler,
    private readonly dataStoreCountRecordsHandler: DataStoreCountRecordsHandler,
    private readonly dataStoreListRecordsHandler: DataStoreListRecordsHandler,
    private readonly aiHandler: AiHandler,
    private readonly emailNotificationHandler: EmailNotificationHandler
  ) {}

  onModuleInit() {
    [
      this.httpRequestHandler,
      this.conditionalHandler,
      this.ifHandler,
      this.switchHandler,
      this.delayHandler,
      this.waitUntilHandler,
      this.transformHandler,
      this.databaseRecordHandler,
      this.dataStoreGetRecordHandler,
      this.dataStoreUpsertRecordHandler,
      this.dataStoreDeleteRecordHandler,
      this.dataStoreExistsRecordHandler,
      this.dataStoreCountRecordsHandler,
      this.dataStoreListRecordsHandler,
      this.emailNotificationHandler
    ].forEach(
      (handler) => this.handlers.set(handler.type, handler)
    );
    this.handlers.set(StepType.AiClassification, this.aiHandler);
    this.handlers.set(StepType.AiStructuredExtraction, this.aiHandler);
    this.handlers.set(StepType.AiSummary, this.aiHandler);
  }

  get(type: string): StepHandler {
    const handler = this.handlers.get(type as StepType);
    if (!handler) {
      throw new Error(`No handler registered for step type ${type}`);
    }
    return handler;
  }
}
