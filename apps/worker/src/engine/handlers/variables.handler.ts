import { Injectable } from "@nestjs/common";
import {
  ExecutionContext,
  StepExecutionStatus,
  StepResult,
  StepType,
  WorkflowStepDefinition,
  assertVariableName,
  assertVariableScope,
  assertVariableValue,
  variableValueSummary,
  variableValueType
} from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { getExecutionRuntimeContext } from "../execution-runtime-context";
import { NonRetryableStepError } from "../step-errors";
import { StepHandler } from "../types";

abstract class VariableHandler implements StepHandler {
  abstract type: StepType;
  constructor(protected readonly resolver: ExpressionResolver) {}

  abstract execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult>;

  protected resolveConfig(step: WorkflowStepDefinition, context: ExecutionContext) {
    try {
      return step.config;
    } catch (error) {
      throw new NonRetryableStepError(error instanceof Error ? error.message : String(error));
    }
  }

  protected resolveValue(config: Record<string, unknown>, context: ExecutionContext) {
    const hasExpression = typeof config.expression === "string" && config.expression.trim();
    const raw = hasExpression ? config.expression : config.value;
    try {
      const mode = context.metadata?.expressionMode === "legacy" ? "legacy" : "strict";
      const resolved = hasExpression ? this.resolver.resolveValue(String(raw), context as unknown as Record<string, unknown>, { mode }) : raw;
      return assertVariableValue(resolved);
    } catch (error) {
      throw new NonRetryableStepError(error instanceof Error ? error.message : String(error));
    }
  }

  protected safeScopeName(config: Record<string, unknown>) {
    try {
      return { scope: assertVariableScope(config.scope), name: assertVariableName(config.name) };
    } catch (error) {
      throw new NonRetryableStepError(error instanceof Error ? error.message : String(error));
    }
  }

  protected output(operation: string, scope: string, name: string, exists: boolean, value?: unknown, extra: Record<string, unknown> = {}) {
    const includeValue = operation === "GET";
    return {
      operation,
      scope,
      name,
      exists,
      type: exists ? variableValueType(value) : "undefined",
      ...(exists && includeValue ? { value } : {}),
      summary: exists ? variableValueSummary(value) : { type: "undefined" },
      ...extra
    };
  }
}

@Injectable()
export class SetVariableHandler extends VariableHandler {
  type = StepType.SetVariable;

  constructor(resolver: ExpressionResolver) {
    super(resolver);
  }

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolveConfig(step, context);
    const { scope, name } = this.safeScopeName(config);
    const value = this.resolveValue(config, context);
    const result = getExecutionRuntimeContext(context).set(scope, name, value);
    return { status: StepExecutionStatus.Completed, output: this.output("SET", scope, name, result.exists, result.value) };
  }
}

@Injectable()
export class GetVariableHandler extends VariableHandler {
  type = StepType.GetVariable;

  constructor(resolver: ExpressionResolver) {
    super(resolver);
  }

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolveConfig(step, context);
    const { scope, name } = this.safeScopeName(config);
    const result = getExecutionRuntimeContext(context).get(scope, name);
    return { status: StepExecutionStatus.Completed, output: this.output("GET", scope, name, result.exists, result.value) };
  }
}

@Injectable()
export class DeleteVariableHandler extends VariableHandler {
  type = StepType.DeleteVariable;

  constructor(resolver: ExpressionResolver) {
    super(resolver);
  }

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolveConfig(step, context);
    const { scope, name } = this.safeScopeName(config);
    const result = getExecutionRuntimeContext(context).delete(scope, name);
    return { status: StepExecutionStatus.Completed, output: this.output("DELETE", scope, name, false, undefined, { existed: result.existed }) };
  }
}

@Injectable()
export class IncrementVariableHandler extends VariableHandler {
  type = StepType.IncrementVariable;

  constructor(resolver: ExpressionResolver) {
    super(resolver);
  }

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolveConfig(step, context);
    const { scope, name } = this.safeScopeName(config);
    try {
      const amount = config.amountExpression ? this.resolver.resolveValue(String(config.amountExpression), context as unknown as Record<string, unknown>) : config.amount;
      const result = getExecutionRuntimeContext(context).increment(scope, name, amount);
      return { status: StepExecutionStatus.Completed, output: this.output("INCREMENT", scope, name, result.exists, result.value) };
    } catch (error) {
      throw new NonRetryableStepError(error instanceof Error ? error.message : String(error));
    }
  }
}

@Injectable()
export class AppendVariableHandler extends VariableHandler {
  type = StepType.AppendVariable;

  constructor(resolver: ExpressionResolver) {
    super(resolver);
  }

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolveConfig(step, context);
    const { scope, name } = this.safeScopeName(config);
    const value = this.resolveValue(config, context);
    try {
      const result = getExecutionRuntimeContext(context).append(scope, name, value);
      return { status: StepExecutionStatus.Completed, output: this.output("APPEND", scope, name, result.exists, result.value) };
    } catch (error) {
      throw new NonRetryableStepError(error instanceof Error ? error.message : String(error));
    }
  }
}
