import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { StepHandler } from "../types";

@Injectable()
export class SwitchHandler implements StepHandler {
  type = StepType.Switch;

  async execute(step: WorkflowStepDefinition, _context: ExecutionContext): Promise<StepResult> {
    const config = step.config as {
      value: unknown;
      cases?: Array<{ key?: string; label?: string; match?: unknown; stepKey?: string }>;
      defaultStepKey?: string;
    };
    const matched = (config.cases ?? []).find((entry) => entry.match === config.value);
    const nextStepKey = matched?.stepKey ?? config.defaultStepKey;
    if (!nextStepKey) {
      throw new Error(`Switch step ${step.key} resolved to a missing branch`);
    }
    return {
      status: StepExecutionStatus.Completed,
      output: {
        matchedCaseKey: matched?.key ?? null,
        matchedCaseLabel: matched?.label ?? null,
        usedDefault: !matched,
        nextStepKey
      },
      control: { nextStepKey }
    };
  }
}
