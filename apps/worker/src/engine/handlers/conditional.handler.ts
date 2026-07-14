import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";

@Injectable()
export class ConditionalHandler implements StepHandler {
  type = StepType.Conditional;

  constructor(private readonly resolver: ExpressionResolver) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      left: unknown;
      operator: "equals" | "not_equals" | "contains";
      right: unknown;
      skipNextOnFalse?: boolean;
    };

    const passed = evaluate(config.left, config.operator, config.right);
    return {
      status: StepExecutionStatus.Completed,
      output: { passed },
      control: {
        skipNext: !passed && config.skipNextOnFalse === true
      }
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
      throw new Error(`Unsupported conditional operator ${operator}`);
  }
}
