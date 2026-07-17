import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreExistsRecordHandler implements StepHandler {
  type = StepType.DataStoreExistsRecord;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const output = await this.dataStore.exists(runtimeContext(context), { ...storeSelector(step.config), key: step.config.key });
    return { status: StepExecutionStatus.Completed, output };
  }
}
