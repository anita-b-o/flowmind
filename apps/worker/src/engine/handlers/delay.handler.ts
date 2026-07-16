import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { StepHandler } from "../types";
import { parseDurationMs } from "../wait-time-parser";

@Injectable()
export class DelayHandler implements StepHandler {
  type = StepType.Delay;

  async execute(step: WorkflowStepDefinition, _context: ExecutionContext): Promise<StepResult> {
    const durationMs = parseDurationMs((step.config as { duration?: unknown }).duration);
    const waitUntil = new Date(Date.now() + durationMs);
    return {
      status: StepExecutionStatus.Completed,
      output: { waitUntil: waitUntil.toISOString(), durationMs, waitReason: "delay" },
      control: { waitUntil: waitUntil.toISOString(), waitReason: "delay" }
    };
  }
}
