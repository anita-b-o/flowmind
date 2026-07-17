import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreDeleteRecordHandler implements StepHandler {
  type = StepType.DataStoreDeleteRecord;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const output = await this.dataStore.delete(runtimeContext(context), { ...storeSelector(step.config), key: step.config.key });
    return { status: StepExecutionStatus.Completed, output };
  }
}
