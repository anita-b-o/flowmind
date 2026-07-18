export type ExpressionMode = "legacy" | "strict";

export type ExpressionValueType = "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";

export type ExpressionNamespace = "trigger" | "workflow" | "steps" | "execution" | "variables" | "system" | "timestamp" | "organization" | "connection" | "metadata" | "item" | "index" | "error";

export type ExpressionSegment = string;

export interface ExpressionPath {
  raw: string;
  namespace: ExpressionNamespace | string;
  segments: ExpressionSegment[];
}

export type TemplatePart =
  | { type: "text"; value: string }
  | { type: "expression"; raw: string; path: ExpressionPath };

export interface ParsedTemplate {
  source: string;
  parts: TemplatePart[];
  expressionCount: number;
  isSingleExpression: boolean;
}

export interface ExpressionScope {
  trigger?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
  steps?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  system?: Record<string, unknown>;
  timestamp?: string;
  organization?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  item?: unknown;
  index?: number;
  error?: Record<string, unknown>;
}

export interface ExpressionParseOptions {
  maxExpressionLength?: number;
  maxInterpolations?: number;
  maxPathDepth?: number;
  maxArrayIndex?: number;
}

export interface ExpressionResolveOptions extends ExpressionParseOptions {
  mode?: ExpressionMode;
}

export interface ExpressionValidationContext extends ExpressionParseOptions {
  availableStepKeys?: string[];
  currentStepKey?: string;
  allowMetadata?: boolean;
  allowConnection?: boolean;
  localNamespaces?: Array<"item" | "index" | "error">;
}

export interface ExpressionValidationIssue {
  code: string;
  message: string;
  path?: string;
  expression?: string;
  namespace?: string;
}

export interface ExpressionValidationResult {
  valid: boolean;
  issues: ExpressionValidationIssue[];
}

export interface VariableCatalogEntry {
  path: string;
  type: ExpressionValueType;
  label: string;
  description?: string;
  namespace: ExpressionNamespace;
}

export interface WorkflowStepLike {
  key: string;
  name?: string;
  type: string;
  config?: Record<string, unknown>;
}
