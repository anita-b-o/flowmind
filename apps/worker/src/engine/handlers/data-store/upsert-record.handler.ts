import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreUpsertRecordHandler implements StepHandler {
  type = StepType.DataStoreUpsertRecord;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = step.config;
    const output = await this.dataStore.upsert(runtimeContext(context), {
      ...storeSelector(config),
      key: config.key,
      value: config.value,
      metadata: config.metadata,
      ttlSeconds: config.ttlSeconds,
      mode: config.mode,
      optimisticConcurrency: config.optimisticConcurrency,
      expectedVersion: config.expectedVersion
    });
    return { status: StepExecutionStatus.Completed, output };
  }
}
