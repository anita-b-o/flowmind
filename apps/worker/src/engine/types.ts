import {
  ExecutionContext,
  StepResult,
  StepType,
  WorkflowStepDefinition
} from "@automation/shared-types";

export interface StepHandler {
  type: StepType;
  execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult>;
}
