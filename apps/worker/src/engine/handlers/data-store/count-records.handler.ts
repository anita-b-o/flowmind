import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreCountRecordsHandler implements StepHandler {
  type = StepType.DataStoreCountRecords;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const output = await this.dataStore.count(runtimeContext(context), { ...storeSelector(step.config), keyPrefix: step.config.keyPrefix });
    return { status: StepExecutionStatus.Completed, output };
  }
}
