export const TRANSFORM_CONFIG_VERSION = 1;

export const TRANSFORM_LIMITS = {
  maxFields: 100,
  maxPaths: 100,
  maxMergeSources: 20,
  maxArrayItems: 1000,
  maxDepth: 12,
  maxStringLength: 32_000,
  maxOutputBytes: 64_000,
  maxConfigBytes: 64_000,
  maxOperations: 10_000
} as const;

export type TransformMode = "OBJECT" | "PICK" | "OMIT" | "MAP_ARRAY" | "FILTER_ARRAY" | "MERGE";
export type TransformConflictPolicy = "LAST_WINS" | "FIRST_WINS" | "ERROR";
export type TransformOutputType = "AUTO" | "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "BOOLEAN";
export type ExpressionValue = unknown;

export type TransformObjectConfig = {
  configVersion?: 1;
  mode: "OBJECT";
  fields: Record<string, ExpressionValue>;
  outputType?: TransformOutputType;
};

export type TransformPickConfig = {
  configVersion?: 1;
  mode: "PICK";
  source: ExpressionValue;
  paths: string[];
  outputType?: TransformOutputType;
};

export type TransformOmitConfig = {
  configVersion?: 1;
  mode: "OMIT";
  source: ExpressionValue;
  paths: string[];
  outputType?: TransformOutputType;
};

export type TransformMapArrayConfig = {
  configVersion?: 1;
  mode: "MAP_ARRAY";
  source: ExpressionValue;
  template: ExpressionValue;
  itemVariable?: "item";
  outputType?: TransformOutputType;
};

export type TransformFilterArrayConfig = {
  configVersion?: 1;
  mode: "FILTER_ARRAY";
  source: ExpressionValue;
  condition: ExpressionValue;
  itemVariable?: "item";
  outputType?: TransformOutputType;
};

export type TransformMergeConfig = {
  configVersion?: 1;
  mode: "MERGE";
  mergeSources: ExpressionValue[];
  conflictPolicy: TransformConflictPolicy;
  outputType?: TransformOutputType;
};

export type TransformStepConfig =
  | TransformObjectConfig
  | TransformPickConfig
  | TransformOmitConfig
  | TransformMapArrayConfig
  | TransformFilterArrayConfig
  | TransformMergeConfig;

export type TransformValidationIssue = {
  code: string;
  message: string;
  path: string;
};

const MODES = new Set<TransformMode>(["OBJECT", "PICK", "OMIT", "MAP_ARRAY", "FILTER_ARRAY", "MERGE"]);
const OUTPUT_TYPES = new Set<TransformOutputType>(["AUTO", "OBJECT", "ARRAY", "STRING", "NUMBER", "BOOLEAN"]);
const CONFLICT_POLICIES = new Set<TransformConflictPolicy>(["LAST_WINS", "FIRST_WINS", "ERROR"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$|^[0-9]+$/;

const ALLOWED_KEYS: Record<TransformMode, Set<string>> = {
  OBJECT: new Set(["configVersion", "mode", "fields", "outputType"]),
  PICK: new Set(["configVersion", "mode", "source", "paths", "outputType"]),
  OMIT: new Set(["configVersion", "mode", "source", "paths", "outputType"]),
  MAP_ARRAY: new Set(["configVersion", "mode", "source", "template", "itemVariable", "outputType"]),
  FILTER_ARRAY: new Set(["configVersion", "mode", "source", "condition", "itemVariable", "outputType"]),
  MERGE: new Set(["configVersion", "mode", "mergeSources", "conflictPolicy", "outputType"])
};

export function validateTransformStepConfig(value: unknown): TransformValidationIssue[] {
  const issues: TransformValidationIssue[] = [];
  if (!isRecord(value)) return [issue("invalid_config", "Transform config must be an object.", "$")];
  if (value.configVersion !== undefined && value.configVersion !== TRANSFORM_CONFIG_VERSION) {
    issues.push(issue("invalid_config_version", "Transform configVersion must be 1.", "$.configVersion"));
  }
  const mode = value.mode;
  if (typeof mode !== "string" || !MODES.has(mode as TransformMode)) {
    issues.push(issue("invalid_mode", "Transform mode is invalid.", "$.mode"));
    return issues;
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS[mode as TransformMode].has(key)) {
      issues.push(issue("incompatible_property", `Property "${key}" is not allowed for ${mode}.`, `$.${key}`));
    }
  }
  if (value.outputType !== undefined && !OUTPUT_TYPES.has(value.outputType as TransformOutputType)) {
    issues.push(issue("invalid_output_type", "Transform outputType is invalid.", "$.outputType"));
  }
  if (serializedBytes(value) > TRANSFORM_LIMITS.maxConfigBytes) {
    issues.push(issue("config_limit_exceeded", "Transform config is too large.", "$"));
  }
  if (mode === "OBJECT") {
    validateFields(value.fields, issues);
    validateObjectOutputType(value.fields, value.outputType, issues);
  }
  if (mode === "PICK" || mode === "OMIT") {
    if (!("source" in value)) issues.push(issue("required_property", "Transform source is required.", "$.source"));
    validatePaths(value.paths, issues);
  }
  if (mode === "MAP_ARRAY") {
    if (!("source" in value)) issues.push(issue("required_property", "Transform source is required.", "$.source"));
    if (!("template" in value)) issues.push(issue("required_property", "Transform template is required.", "$.template"));
    validateItemVariable(value.itemVariable, issues);
  }
  if (mode === "FILTER_ARRAY") {
    if (!("source" in value)) issues.push(issue("required_property", "Transform source is required.", "$.source"));
    if (!("condition" in value)) issues.push(issue("required_property", "Transform condition is required.", "$.condition"));
    validateItemVariable(value.itemVariable, issues);
  }
  if (mode === "MERGE") {
    if (!Array.isArray(value.mergeSources) || value.mergeSources.length < 2) {
      issues.push(issue("invalid_merge_sources", "MERGE requires at least two sources.", "$.mergeSources"));
    } else if (value.mergeSources.length > TRANSFORM_LIMITS.maxMergeSources) {
      issues.push(issue("config_limit_exceeded", `MERGE supports at most ${TRANSFORM_LIMITS.maxMergeSources} sources.`, "$.mergeSources"));
    }
    if (!CONFLICT_POLICIES.has(value.conflictPolicy as TransformConflictPolicy)) {
      issues.push(issue("invalid_conflict_policy", "MERGE conflictPolicy is invalid.", "$.conflictPolicy"));
    }
  }
  return issues;
}

export function isDangerousTransformKey(key: string) {
  return DANGEROUS_KEYS.has(key);
}

export function isSafeTransformPath(path: string) {
  if (typeof path !== "string" || !path.trim() || path.length > 512) return false;
  return path.split(".").every((segment) => segment && !DANGEROUS_KEYS.has(segment) && PATH_SEGMENT.test(segment));
}

function validateFields(value: unknown, issues: TransformValidationIssue[]) {
  if (!isRecord(value)) {
    issues.push(issue("invalid_fields", "OBJECT fields must be an object.", "$.fields"));
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > TRANSFORM_LIMITS.maxFields) {
    issues.push(issue("config_limit_exceeded", `OBJECT supports at most ${TRANSFORM_LIMITS.maxFields} fields.`, "$.fields"));
  }
  for (const key of keys) {
    if (isDangerousTransformKey(key)) issues.push(issue("dangerous_key", `Field key "${key}" is not allowed.`, `$.fields.${key}`));
    validateSafeObjectKeys(value[key], `$.fields.${key}`, issues);
  }
}

function validateObjectOutputType(fields: unknown, outputType: unknown, issues: TransformValidationIssue[]) {
  if (outputType !== "STRING" && outputType !== "NUMBER" && outputType !== "BOOLEAN") return;
  if (!isRecord(fields)) return;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== "value") {
    issues.push(issue("invalid_output_type", "OBJECT scalar outputType requires exactly one field named \"value\".", "$.outputType"));
  }
}

function validatePaths(value: unknown, issues: TransformValidationIssue[]) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("invalid_paths", "Paths must contain at least one path.", "$.paths"));
    return;
  }
  if (value.length > TRANSFORM_LIMITS.maxPaths) {
    issues.push(issue("config_limit_exceeded", `At most ${TRANSFORM_LIMITS.maxPaths} paths are allowed.`, "$.paths"));
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !isSafeTransformPath(entry)) {
      issues.push(issue("invalid_path", "Path is invalid or unsafe.", `$.paths.${index}`));
      return;
    }
    if (seen.has(entry)) issues.push(issue("duplicate_path", "Paths must be unique.", `$.paths.${index}`));
    seen.add(entry);
  });
}

function validateItemVariable(value: unknown, issues: TransformValidationIssue[]) {
  if (value !== undefined && value !== "item") {
    issues.push(issue("invalid_item_variable", "Only itemVariable \"item\" is supported.", "$.itemVariable"));
  }
}

function issue(code: string, message: string, path: string): TransformValidationIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateSafeObjectKeys(value: unknown, path: string, issues: TransformValidationIssue[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSafeObjectKeys(entry, `${path}.${index}`, issues));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isDangerousTransformKey(key)) issues.push(issue("dangerous_key", `Field key "${key}" is not allowed.`, `${path}.${key}`));
    validateSafeObjectKeys((value as Record<string, unknown>)[key], `${path}.${key}`, issues);
  }
}

function serializedBytes(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
