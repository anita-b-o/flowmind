export type VariableScope = "execution" | "workflow";

export type VariableOperation = "SET" | "GET" | "DELETE" | "INCREMENT" | "APPEND";

export const VARIABLE_SCOPES: readonly VariableScope[] = ["execution", "workflow"] as const;

export const WORKFLOW_VARIABLE_LIMITS = {
  maxNameLength: 64,
  maxValueBytes: 64_000,
  maxDepth: 12,
  maxStringLength: 32_000,
  maxArrayItems: 1_000,
  maxOperations: 10_000
} as const;

export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const VARIABLE_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const VARIABLE_RESERVED_NAMES = new Set([
  "trigger",
  "workflow",
  "execution",
  "variables",
  "steps",
  "system",
  "timestamp",
  "item",
  "index",
  "metadata",
  "organization",
  "connection",
  "environment",
  "__runtime"
]);

export class WorkflowVariableValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WorkflowVariableValidationError";
  }
}

export function isVariableScope(value: unknown): value is VariableScope {
  return value === "execution" || value === "workflow";
}

export function assertVariableScope(value: unknown): VariableScope {
  if (!isVariableScope(value)) throw new WorkflowVariableValidationError("INVALID_SCOPE", "Variable scope must be execution or workflow.");
  return value;
}

export function assertVariableName(value: unknown): string {
  if (typeof value !== "string" || !VARIABLE_NAME_PATTERN.test(value)) {
    throw new WorkflowVariableValidationError("INVALID_NAME", "Variable name must be 1-64 chars using letters, numbers, _ or - and start with a letter or _.");
  }
  if (VARIABLE_RESERVED_NAMES.has(value) || VARIABLE_DANGEROUS_KEYS.has(value)) {
    throw new WorkflowVariableValidationError("RESERVED_NAME", `Variable name "${value}" is reserved.`);
  }
  return value;
}

export function assertVariableValue(value: unknown, label = "variable"): unknown {
  assertSafeWorkflowVariableJson(value, { maxBytes: WORKFLOW_VARIABLE_LIMITS.maxValueBytes, label });
  return cloneJson(value);
}

export function assertWorkflowVariables(value: unknown, label = "workflow variables"): Record<string, unknown> {
  const record = value === undefined || value === null ? {} : value;
  if (!isPlainObject(record)) throw new WorkflowVariableValidationError("INVALID_VARIABLES", `${label} must be a JSON object.`);
  for (const [key, entry] of Object.entries(record)) {
    assertVariableName(key);
    assertVariableValue(entry, `${label}.${key}`);
  }
  return cloneJson(record) as Record<string, unknown>;
}

export function variableValueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function variableValueSummary(value: unknown): Record<string, unknown> {
  const type = variableValueType(value);
  if (Array.isArray(value)) return { type, length: value.length };
  if (isPlainObject(value)) return { type: "object", keys: Object.keys(value).length };
  if (typeof value === "string") return { type, length: value.length };
  return { type };
}

function assertSafeWorkflowVariableJson(value: unknown, options: { maxBytes: number; label: string }) {
  let operations = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number) => {
    operations += 1;
    if (operations > WORKFLOW_VARIABLE_LIMITS.maxOperations) throw new WorkflowVariableValidationError("LIMIT_EXCEEDED", `${options.label} is too complex.`);
    if (depth > WORKFLOW_VARIABLE_LIMITS.maxDepth) throw new WorkflowVariableValidationError("LIMIT_EXCEEDED", `${options.label} exceeds maximum JSON depth.`);
    if (entry === undefined || typeof entry === "function" || typeof entry === "bigint" || typeof entry === "symbol") {
      throw new WorkflowVariableValidationError("VALUE_NOT_JSON", `${options.label} must be valid JSON.`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new WorkflowVariableValidationError("VALUE_NOT_JSON", `${options.label} numbers must be finite.`);
    }
    if (typeof entry === "string" && entry.length > WORKFLOW_VARIABLE_LIMITS.maxStringLength) {
      throw new WorkflowVariableValidationError("LIMIT_EXCEEDED", `${options.label} string exceeds maximum length.`);
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) throw new WorkflowVariableValidationError("VALUE_NOT_JSON", `${options.label} cannot contain circular references.`);
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > WORKFLOW_VARIABLE_LIMITS.maxArrayItems) throw new WorkflowVariableValidationError("LIMIT_EXCEEDED", `${options.label} array has too many items.`);
      entry.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isPlainObject(entry)) throw new WorkflowVariableValidationError("VALUE_NOT_JSON", `${options.label} must contain plain JSON objects only.`);
    for (const [key, child] of Object.entries(entry)) {
      if (VARIABLE_DANGEROUS_KEYS.has(key) || VARIABLE_RESERVED_NAMES.has(key)) {
        throw new WorkflowVariableValidationError("DANGEROUS_KEY", `Variable key "${key}" is not allowed.`);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized.length > options.maxBytes) throw new WorkflowVariableValidationError("LIMIT_EXCEEDED", `${options.label} exceeds maximum size.`);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
