import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepType, assertSubworkflowJson, type ExecutionContext, type StepResult, type WorkflowStepDefinition } from "@automation/shared-types";
import type { StepHandler } from "../types";

@Injectable()
export class ReturnWorkflowOutputHandler implements StepHandler {
  readonly type = StepType.ReturnWorkflowOutput;
  async execute(step: WorkflowStepDefinition, _context: ExecutionContext): Promise<StepResult> {
    return { status: StepExecutionStatus.Completed, output: assertSubworkflowJson(step.config.output ?? null, "output") };
  }
}
