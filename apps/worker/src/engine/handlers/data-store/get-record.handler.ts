import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition, ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeService } from "../../../data-store/data-store-runtime.service";
import { StepHandler } from "../../types";
import { runtimeContext, storeSelector } from "./common";

@Injectable()
export class DataStoreGetRecordHandler implements StepHandler {
  type = StepType.DataStoreGetRecord;

  constructor(private readonly dataStore: DataStoreRuntimeService) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = step.config;
    const output = await this.dataStore.get(runtimeContext(context), { ...storeSelector(config), key: config.key, failIfMissing: config.failIfMissing });
    return { status: StepExecutionStatus.Completed, output };
  }
}
