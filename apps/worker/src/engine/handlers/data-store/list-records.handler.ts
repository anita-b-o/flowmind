import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreListRecordsHandler implements StepHandler {
  type = StepType.DataStoreListRecords;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const output = await this.dataStore.list(runtimeContext(context), {
      ...storeSelector(step.config),
      limit: step.config.limit,
      offset: step.config.offset,
      sortBy: step.config.sortBy,
      direction: step.config.direction,
      keyPrefix: step.config.keyPrefix
    });
    return { status: StepExecutionStatus.Completed, output };
  }
}
