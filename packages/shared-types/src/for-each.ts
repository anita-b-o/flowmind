export const FOR_EACH_LIMITS = {
  defaultMaxItems: 100,
  maxItems: 1_000,
  defaultMaxResults: 20,
  maxResults: 100,
  maxErrors: 20,
  maxConcurrency: 1,
  maxNestedDepth: 1,
  maxStepExecutions: 10_000,
  maxSourceBytes: 1_048_576
} as const;

export type ForEachMode = "SEQUENTIAL";

export type ForEachConfig = {
  source: unknown;
  itemVariable?: string;
  indexVariable?: string;
  mode: ForEachMode;
  concurrency: 1;
  continueOnError: boolean;
  maxItems: number;
  collectResults: boolean;
  maxResults: number;
};

export type ForEachErrorSummary = {
  iterationIndex: number;
  stepKey?: string;
  code?: string;
  message: string;
};

export type ForEachOutput = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  mode: ForEachMode;
  results?: unknown[];
  resultsTruncated?: boolean;
  errors?: ForEachErrorSummary[];
  errorsTruncated?: boolean;
};

export function normalizeForEachConfig(value: Record<string, unknown>): ForEachConfig {
  return {
    source: value.source,
    itemVariable: optionalName(value.itemVariable),
    indexVariable: optionalName(value.indexVariable),
    mode: "SEQUENTIAL",
    concurrency: 1,
    continueOnError: value.continueOnError === true,
    maxItems: integer(value.maxItems, FOR_EACH_LIMITS.defaultMaxItems),
    collectResults: value.collectResults !== false,
    maxResults: integer(value.maxResults, FOR_EACH_LIMITS.defaultMaxResults)
  };
}

function optionalName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}
