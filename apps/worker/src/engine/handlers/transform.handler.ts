import { Injectable } from "@nestjs/common";
import {
  ExecutionContext,
  isDangerousTransformKey,
  isSafeTransformPath,
  StepExecutionStatus,
  StepResult,
  StepType,
  TRANSFORM_LIMITS,
  TransformStepConfig,
  validateTransformStepConfig,
  WorkflowStepDefinition
} from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { NonRetryableStepError } from "../step-errors";
import { StepHandler } from "../types";

@Injectable()
export class TransformHandler implements StepHandler {
  type = StepType.Transform;

  constructor(private readonly resolver: ExpressionResolver) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const output = executeTransform(step.config, context, this.resolver);
    return { status: StepExecutionStatus.Completed, output };
  }
}

export class TransformStepError extends NonRetryableStepError {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`Transform ${code}: ${message}`);
    this.name = "TransformStepError";
  }
}

export function executeTransform(configValue: Record<string, unknown>, context: ExecutionContext, resolver = new ExpressionResolver()): unknown {
  const issues = validateTransformStepConfig(configValue);
  if (issues.length) {
    throw new TransformStepError("INVALID_CONFIG", issues[0].message, { issue: issues[0] });
  }
  const config = configValue as TransformStepConfig;
  let output: unknown;
  switch (config.mode) {
    case "OBJECT":
      output = resolveTemplateValue(config.fields, context, resolver);
      if (isScalarOutputType(config.outputType) && isPlainObject(output) && Object.keys(output).length === 1 && Object.prototype.hasOwnProperty.call(output, "value")) {
        output = output.value;
      }
      break;
    case "PICK":
      output = pickPaths(requirePlainObject(resolveTemplateValue(config.source, context, resolver), "source"), config.paths);
      break;
    case "OMIT":
      output = omitPaths(requirePlainObject(resolveTemplateValue(config.source, context, resolver), "source"), config.paths);
      break;
    case "MAP_ARRAY":
      output = mapArray(requireArray(resolveTemplateValue(config.source, context, resolver), "source"), config.template, context, resolver);
      break;
    case "FILTER_ARRAY":
      output = filterArray(requireArray(resolveTemplateValue(config.source, context, resolver), "source"), config.condition, context, resolver);
      break;
    case "MERGE":
      output = mergeObjects(config.mergeSources.map((source) => requirePlainObject(resolveTemplateValue(source, context, resolver), "mergeSources")), config.conflictPolicy);
      break;
  }
  output = convertTransformOutput(output, config.outputType ?? "AUTO");
  assertResultLimits(output);
  return output;
}

function resolveTemplateValue(value: unknown, context: ExecutionContext, resolver: ExpressionResolver, locals?: { item: unknown; index: number }): unknown {
  try {
    return resolver.resolveValue(value, { ...(context as unknown as Record<string, unknown>), ...(locals ?? {}) }, { mode: context.metadata?.expressionMode === "legacy" ? "legacy" : "strict" });
  } catch (error) {
    throw new TransformStepError("EXPRESSION_UNRESOLVED", error instanceof Error ? error.message : String(error));
  }
}

function pickPaths(source: Record<string, unknown>, paths: string[]) {
  const output: Record<string, unknown> = {};
  for (const path of uniqueSafePaths(paths)) {
    const read = readPath(source, path);
    if (read.found) setPath(output, path, cloneJson(read.value));
  }
  return output;
}

function omitPaths(source: Record<string, unknown>, paths: string[]) {
  const output = cloneJson(source) as Record<string, unknown>;
  for (const path of uniqueSafePaths(paths)) deletePath(output, path);
  return output;
}

function mapArray(source: unknown[], template: unknown, context: ExecutionContext, resolver: ExpressionResolver) {
  assertArrayLimit(source);
  return source.map((item, index) => {
    try {
      return resolveTemplateValue(template, context, resolver, { item, index });
    } catch (error) {
      throw indexedTransformError(error, index);
    }
  });
}

function filterArray(source: unknown[], condition: unknown, context: ExecutionContext, resolver: ExpressionResolver) {
  assertArrayLimit(source);
  return source.filter((item, index) => {
    let result: unknown;
    try {
      result = resolveTemplateValue(condition, context, resolver, { item, index });
    } catch (error) {
      throw indexedTransformError(error, index);
    }
    if (typeof result !== "boolean") {
      throw new TransformStepError("EXPRESSION_TYPE_INVALID", "FILTER_ARRAY condition must resolve to a boolean.", { actualType: valueType(result), index });
    }
    return result;
  });
}

function indexedTransformError(error: unknown, index: number) {
  if (error instanceof TransformStepError) {
    return new TransformStepError(error.code, `${error.message.replace(/^Transform [A-Z_]+:\s*/, "")} at index ${index}`, { ...error.details, index });
  }
  return new TransformStepError("EXPRESSION_UNRESOLVED", error instanceof Error ? error.message : String(error), { index });
}

function mergeObjects(sources: Record<string, unknown>[], policy: "LAST_WINS" | "FIRST_WINS" | "ERROR") {
  const output: Record<string, unknown> = {};
  for (const source of sources) {
    assertSafeJsonValue(source);
    for (const [key, value] of Object.entries(source)) {
      assertSafeKey(key);
      if (policy === "ERROR" && key in output && JSON.stringify(output[key]) !== JSON.stringify(value)) {
        throw new TransformStepError("MERGE_CONFLICT", `MERGE conflict at key "${key}".`);
      }
      if (policy === "FIRST_WINS" && key in output) continue;
      output[key] = cloneJson(value);
    }
  }
  return output;
}

export function convertTransformOutput(value: unknown, outputType: string) {
  if (outputType === "AUTO") return value;
  if (outputType === "STRING") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
    throw new TransformStepError("CONVERSION_INVALID", "Only scalar values can be converted to string.");
  }
  if (outputType === "NUMBER") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.trim())) return Number(value);
    throw new TransformStepError("CONVERSION_INVALID", "Value cannot be converted to number.");
  }
  if (outputType === "BOOLEAN") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new TransformStepError("CONVERSION_INVALID", "Value cannot be converted to boolean.");
  }
  if (outputType === "OBJECT") return requirePlainObject(value, "output");
  if (outputType === "ARRAY") return requireArray(value, "output");
  return value;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TransformStepError("SOURCE_TYPE_INVALID", `Transform ${label} must resolve to an object.`, { actualType: valueType(value) });
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TransformStepError("SOURCE_TYPE_INVALID", `Transform ${label} must resolve to an array.`, { actualType: valueType(value) });
  return value;
}

function uniqueSafePaths(paths: string[]) {
  const result: string[] = [];
  for (const path of paths) {
    if (!isSafeTransformPath(path)) throw new TransformStepError("PATH_INVALID", "Transform path is invalid or unsafe.");
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

function readPath(source: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (Array.isArray(current) && /^[0-9]+$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let current = target;
  segments.forEach((segment, index) => {
    assertSafeKey(segment);
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (!isPlainObject(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  });
}

function deletePath(target: Record<string, unknown>, path: string) {
  const segments = path.split(".");
  let current: unknown = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    assertSafeKey(segment);
    if (!isPlainObject(current)) return;
    current = current[segment];
  }
  if (isPlainObject(current)) delete current[segments[segments.length - 1]];
}

function assertSafeKey(key: string) {
  if (isDangerousTransformKey(key)) throw new TransformStepError("DANGEROUS_KEY", `Key "${key}" is not allowed.`);
}

function assertArrayLimit(source: unknown[]) {
  if (source.length > TRANSFORM_LIMITS.maxArrayItems) {
    throw new TransformStepError("LIMIT_EXCEEDED", `Array contains more than ${TRANSFORM_LIMITS.maxArrayItems} items.`);
  }
}

function assertResultLimits(value: unknown) {
  let operations = 0;
  const visit = (entry: unknown, depth: number) => {
    operations += 1;
    if (operations > TRANSFORM_LIMITS.maxOperations) throw new TransformStepError("LIMIT_EXCEEDED", "Transform operation limit exceeded.");
    if (depth > TRANSFORM_LIMITS.maxDepth) throw new TransformStepError("LIMIT_EXCEEDED", "Transform output depth limit exceeded.");
    if (entry === undefined || typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") throw new TransformStepError("VALUE_NOT_JSON", "Transform output must be JSON serializable.");
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new TransformStepError("VALUE_NOT_JSON", "Transform output numbers must be finite.");
    if (typeof entry === "string" && entry.length > TRANSFORM_LIMITS.maxStringLength) throw new TransformStepError("LIMIT_EXCEEDED", "Transform string length limit exceeded.");
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      if (entry.length > TRANSFORM_LIMITS.maxArrayItems) throw new TransformStepError("LIMIT_EXCEEDED", "Transform output array limit exceeded.");
      entry.forEach((item) => visit(item, depth + 1));
      return;
    }
    Object.entries(entry as Record<string, unknown>).forEach(([key, item]) => {
      assertSafeKey(key);
      visit(item, depth + 1);
    });
  };
  visit(value, 0);
  if (JSON.stringify(value).length > TRANSFORM_LIMITS.maxOutputBytes) {
    throw new TransformStepError("LIMIT_EXCEEDED", "Transform output size limit exceeded.");
  }
}

function cloneJson(value: unknown): unknown {
  assertSafeJsonValue(value);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new TransformStepError("VALUE_NOT_JSON", "Transform value must be JSON serializable.");
  }
}

function assertSafeJsonValue(value: unknown) {
  const visit = (entry: unknown) => {
    if (entry === undefined || typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") {
      throw new TransformStepError("VALUE_NOT_JSON", "Transform value must be JSON serializable.");
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new TransformStepError("VALUE_NOT_JSON", "Transform numbers must be finite.");
    }
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isPlainObject(entry)) throw new TransformStepError("VALUE_NOT_JSON", "Transform objects must be plain JSON objects.");
    for (const [key, child] of Object.entries(entry)) {
      assertSafeKey(key);
      visit(child);
    }
  };
  visit(value);
}

function isScalarOutputType(outputType: string | undefined) {
  return outputType === "STRING" || outputType === "NUMBER" || outputType === "BOOLEAN";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function valueType(value: unknown) {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
