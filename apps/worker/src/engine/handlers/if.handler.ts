import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { StepHandler } from "../types";

@Injectable()
export class IfHandler implements StepHandler {
  type = StepType.If;

  async execute(step: WorkflowStepDefinition, _context: ExecutionContext): Promise<StepResult> {
    const config = step.config as {
      left: unknown;
      operator: "equals" | "not_equals" | "contains";
      right: unknown;
      trueStepKey?: string;
      falseStepKey?: string;
    };
    const matched = evaluate(config.left, config.operator, config.right);
    const branch = matched ? "true" : "false";
    const nextStepKey = matched ? config.trueStepKey : config.falseStepKey;
    if (!nextStepKey) {
      throw new Error(`If step ${step.key} resolved to a missing ${branch} branch`);
    }
    return {
      status: StepExecutionStatus.Completed,
      output: { matched, branch, nextStepKey },
      control: { nextStepKey }
    };
  }
}

function evaluate(left: unknown, operator: string, right: unknown) {
  switch (operator) {
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "contains":
      return String(left).includes(String(right));
    default:
      throw new Error(`Unsupported if operator ${operator}`);
  }
}
