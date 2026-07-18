import {
  ExecutionContext,
  StepExecutionStatus,
  assertVariableName,
  assertVariableScope,
  assertVariableValue,
  variableValueType,
  type VariableScope
} from "@automation/shared-types";

type RuntimeBinding = { runtime: ExecutionRuntimeContext; aliases: Readonly<Record<string, unknown>> };
const runtimeContexts = new WeakMap<ExecutionContext, RuntimeBinding>();

export class ExecutionRuntimeContext {
  readonly context: ExecutionContext;
  private readonly executionVariables: Record<string, unknown>;
  private readonly workflowVariables: Record<string, unknown>;

  constructor(base: ExecutionContext, checkpoint?: unknown) {
    const runtime = checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? (checkpoint as Record<string, unknown>) : {};
    this.executionVariables = cloneRecord(runtime.variables ?? {});
    this.workflowVariables = cloneRecord(base.workflow?.variables ?? {});
    const executionVariablesView = readonlyRecord(this.executionVariables, "execution variables");
    const workflowVariablesView = readonlyRecord(this.workflowVariables, "workflow variables");
    const workflow = Object.freeze({
      ...(base.workflow ?? {}),
      variables: workflowVariablesView,
      environment: deepFreeze(cloneRecord(base.workflow?.environment ?? {}))
    });
    const execution = Object.freeze({ ...(base.execution ?? {}), variables: executionVariablesView });
    const now = new Date().toISOString();
    this.context = {
      ...base,
      trigger: deepFreeze(cloneRecord(base.trigger ?? {})),
      workflow,
      execution,
      variables: executionVariablesView,
      system: Object.freeze({
        ...(base.system ?? {}),
        now,
        executionMode: String(base.metadata?.executionMode ?? "REAL")
      }),
      timestamp: now,
      steps: base.steps ?? {}
    };
    runtimeContexts.set(this.context, { runtime: this, aliases: {} });
  }

  static fromContext(context: ExecutionContext): ExecutionRuntimeContext {
    const binding = runtimeContexts.get(context);
    if (!binding) throw new Error("Execution runtime context is not available");
    return binding.runtime;
  }

  createIterationFrame(input: { item: unknown; index: number; itemVariable?: string; indexVariable?: string; steps?: ExecutionContext["steps"] }) {
    const aliases: Record<string, unknown> = {};
    if (input.itemVariable) aliases[input.itemVariable] = input.item;
    if (input.indexVariable) aliases[input.indexVariable] = input.index;
    const variables = new Proxy(this.context.variables ?? {}, {
      get: (target, property, receiver) => typeof property === "string" && Object.prototype.hasOwnProperty.call(aliases, property) ? aliases[property] : Reflect.get(target, property, receiver),
      has: (target, property) => typeof property === "string" && Object.prototype.hasOwnProperty.call(aliases, property) || Reflect.has(target, property),
      ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...Object.keys(aliases)])],
      getOwnPropertyDescriptor: (target, property) => typeof property === "string" && Object.prototype.hasOwnProperty.call(aliases, property)
        ? { configurable: true, enumerable: true, writable: false, value: aliases[property] }
        : Reflect.getOwnPropertyDescriptor(target, property)
    });
    const context: ExecutionContext = {
      ...this.context,
      steps: input.steps ?? {},
      variables,
      execution: { ...(this.context.execution ?? {}), variables },
      item: input.item,
      index: input.index,
      metadata: { ...(this.context.metadata ?? {}), iteration: { index: input.index } }
    };
    runtimeContexts.set(context, { runtime: this, aliases: Object.freeze(aliases) });
    return context;
  }

  get(scope: VariableScope, name: string): { exists: boolean; value?: unknown; type: string } {
    const target = this.target(scope);
    const exists = Object.prototype.hasOwnProperty.call(target, name);
    const value = exists ? target[name] : undefined;
    return { exists, value, type: exists ? variableValueType(value) : "undefined" };
  }

  set(scopeValue: unknown, nameValue: unknown, value: unknown) {
    const scope = assertVariableScope(scopeValue);
    const name = assertVariableName(nameValue);
    this.target(scope)[name] = assertVariableValue(value, `${scope}.${name}`);
    return this.get(scope, name);
  }

  delete(scopeValue: unknown, nameValue: unknown) {
    const scope = assertVariableScope(scopeValue);
    const name = assertVariableName(nameValue);
    const target = this.target(scope);
    const existed = Object.prototype.hasOwnProperty.call(target, name);
    delete target[name];
    return { existed };
  }

  increment(scopeValue: unknown, nameValue: unknown, amountValue: unknown) {
    const scope = assertVariableScope(scopeValue);
    const name = assertVariableName(nameValue);
    const amount = amountValue === undefined || amountValue === null || amountValue === "" ? 1 : Number(amountValue);
    if (!Number.isFinite(amount)) throw new Error("INCREMENT_VARIABLE amount must be a finite number");
    const current = this.get(scope, name);
    if (current.exists && typeof current.value !== "number") throw new Error("INCREMENT_VARIABLE can only increment numbers");
    const next = (current.exists ? (current.value as number) : 0) + amount;
    if (!Number.isFinite(next)) throw new Error("INCREMENT_VARIABLE result must be finite");
    return this.set(scope, name, next);
  }

  append(scopeValue: unknown, nameValue: unknown, value: unknown) {
    const scope = assertVariableScope(scopeValue);
    const name = assertVariableName(nameValue);
    const current = this.get(scope, name);
    if (current.exists && !Array.isArray(current.value)) throw new Error("APPEND_VARIABLE can only append to arrays");
    const next = [...(current.exists ? (current.value as unknown[]) : []), assertVariableValue(value, `${scope}.${name}.item`)];
    return this.set(scope, name, next);
  }

  setStepResult(stepKey: string, status: StepExecutionStatus, output: unknown) {
    this.context.steps[stepKey] = { status, output };
  }

  snapshot(options: { includeRuntime: boolean }) {
    const output: ExecutionContext & { __runtime?: Record<string, unknown> } = {
      ...this.context,
      workflow: { ...(this.context.workflow ?? {}), variables: this.workflowVariables },
      execution: { ...(this.context.execution ?? {}), variables: options.includeRuntime ? this.executionVariables : {} },
      variables: options.includeRuntime ? this.executionVariables : {},
      connection: {},
      item: undefined,
      index: undefined
    };
    if (options.includeRuntime) {
      output.__runtime = { variables: cloneRecord(this.executionVariables) };
    }
    return output;
  }

  private target(scope: VariableScope) {
    return scope === "workflow" ? this.workflowVariables : this.executionVariables;
  }
}

export function getExecutionRuntimeContext(context: ExecutionContext) {
  const binding = runtimeContexts.get(context);
  if (!binding) throw new Error("Execution runtime context is not available");
  const reserved = (scope: VariableScope, name: string) => {
    if (scope === "execution" && Object.prototype.hasOwnProperty.call(binding.aliases, name)) throw new Error(`Iteration variable "${name}" is read-only.`);
  };
  return {
    get(scope: VariableScope, name: string) {
      if (scope === "execution" && Object.prototype.hasOwnProperty.call(binding.aliases, name)) return { exists: true, value: binding.aliases[name], type: variableValueType(binding.aliases[name]) };
      return binding.runtime.get(scope, name);
    },
    set(scope: unknown, name: unknown, value: unknown) {
      const checkedScope = assertVariableScope(scope);
      const checkedName = assertVariableName(name);
      reserved(checkedScope, checkedName);
      return binding.runtime.set(checkedScope, checkedName, value);
    },
    delete(scope: unknown, name: unknown) {
      const checkedScope = assertVariableScope(scope);
      const checkedName = assertVariableName(name);
      reserved(checkedScope, checkedName);
      return binding.runtime.delete(checkedScope, checkedName);
    },
    increment(scope: unknown, name: unknown, amount: unknown) {
      const checkedScope = assertVariableScope(scope);
      const checkedName = assertVariableName(name);
      reserved(checkedScope, checkedName);
      return binding.runtime.increment(checkedScope, checkedName, amount);
    },
    append(scope: unknown, name: unknown, value: unknown) {
      const checkedScope = assertVariableScope(scope);
      const checkedName = assertVariableName(name);
      reserved(checkedScope, checkedName);
      return binding.runtime.append(checkedScope, checkedName, value);
    }
  };
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readonlyRecord(target: Record<string, unknown>, label: string): Record<string, unknown> {
  return new Proxy(target, {
    set() {
      throw new Error(`Runtime ${label} are read-only; use ExecutionRuntimeContext APIs.`);
    },
    deleteProperty() {
      throw new Error(`Runtime ${label} are read-only; use ExecutionRuntimeContext APIs.`);
    },
    defineProperty() {
      throw new Error(`Runtime ${label} are read-only; use ExecutionRuntimeContext APIs.`);
    },
    setPrototypeOf() {
      throw new Error(`Runtime ${label} prototype cannot be changed.`);
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
