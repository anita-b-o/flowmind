import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { StepHandler } from "../types";
import { parseWaitUntil } from "../wait-time-parser";

@Injectable()
export class WaitUntilHandler implements StepHandler {
  type = StepType.WaitUntil;

  async execute(step: WorkflowStepDefinition, _context: ExecutionContext): Promise<StepResult> {
    const waitUntil = parseWaitUntil((step.config as { timestamp?: unknown }).timestamp);
    return {
      status: StepExecutionStatus.Completed,
      output: { waitUntil: waitUntil.toISOString(), waitReason: "wait_until" },
      control: { waitUntil: waitUntil.toISOString(), waitReason: "wait_until" }
    };
  }
}
