export const DATA_STORE_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 500,
  maxKeyLength: 256,
  maxValueBytes: 64_000,
  maxMetadataBytes: 8_000,
  maxDepth: 12,
  maxStringLength: 32_000,
  maxArrayItems: 1_000,
  maxRecordsPerStore: 50_000,
  maxListLimit: 100
} as const;

export const DATA_STORE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;
export const DATA_STORE_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type DataStoreSortBy = "key" | "createdAt" | "updatedAt";
export type DataStoreSortDirection = "asc" | "desc";
export type DataStoreUpsertMode = "replace" | "merge";

export type DataStoreSelector = {
  dataStoreId?: string;
  dataStoreName?: string;
};

export type DataStoreRecordTimestamps = {
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt?: string | Date | null;
  deletedAt?: string | Date | null;
};

export type DataStoreRecordOutput = {
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  version: number;
  timestamps: DataStoreRecordTimestamps;
};

export class DataStoreValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DataStoreValidationError";
  }
}

export function assertDataStoreName(name: unknown): string {
  if (typeof name !== "string" || !DATA_STORE_NAME_PATTERN.test(name.trim())) {
    throw new DataStoreValidationError("INVALID_STORE_NAME", "Data Store name must be 1-80 chars using letters, numbers, spaces, _ or - and start with a letter or number.");
  }
  return name.trim();
}

export function assertDataStoreDescription(description: unknown): string | undefined {
  if (description === undefined || description === null || description === "") return undefined;
  if (typeof description !== "string" || description.length > DATA_STORE_LIMITS.maxDescriptionLength) {
    throw new DataStoreValidationError("INVALID_DESCRIPTION", `Data Store description must be at most ${DATA_STORE_LIMITS.maxDescriptionLength} characters.`);
  }
  return description;
}

export function assertDataStoreKey(key: unknown): string {
  if (typeof key !== "string" || !key.trim() || key.length > DATA_STORE_LIMITS.maxKeyLength) {
    throw new DataStoreValidationError("INVALID_KEY", `Data Store key must be 1-${DATA_STORE_LIMITS.maxKeyLength} characters.`);
  }
  if (key.includes("\0")) throw new DataStoreValidationError("INVALID_KEY", "Data Store key cannot contain null bytes.");
  return key;
}

export function assertDataStoreSelector(selector: DataStoreSelector): DataStoreSelector {
  const dataStoreId = typeof selector.dataStoreId === "string" ? selector.dataStoreId.trim() : "";
  const dataStoreName = typeof selector.dataStoreName === "string" ? selector.dataStoreName.trim() : "";
  if (!dataStoreId && !dataStoreName) {
    throw new DataStoreValidationError("MISSING_STORE", "Data Store id or name is required.");
  }
  return {
    ...(dataStoreId ? { dataStoreId } : {}),
    ...(dataStoreName ? { dataStoreName: assertDataStoreName(dataStoreName) } : {})
  };
}

export function assertDataStoreValue(value: unknown): unknown {
  assertSafeJson(value, { maxBytes: DATA_STORE_LIMITS.maxValueBytes, label: "value" });
  return cloneJson(value);
}

export function assertDataStoreMetadata(value: unknown): Record<string, unknown> {
  const metadata = value === undefined || value === null || value === "" ? {} : value;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new DataStoreValidationError("INVALID_METADATA", "Data Store metadata must be a JSON object.");
  }
  assertSafeJson(metadata, { maxBytes: DATA_STORE_LIMITS.maxMetadataBytes, label: "metadata" });
  return cloneJson(metadata) as Record<string, unknown>;
}

export function ttlSecondsToExpiresAt(value: unknown, now = new Date()): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new DataStoreValidationError("INVALID_TTL", "Data Store ttlSeconds must be a non-negative number.");
  }
  if (seconds === 0) return now;
  return new Date(now.getTime() + Math.floor(seconds * 1000));
}

export function normalizeListLimit(value: unknown): number {
  const limit = value === undefined || value === null || value === "" ? 20 : Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new DataStoreValidationError("INVALID_LIMIT", "Data Store list limit must be a positive integer.");
  return Math.min(limit, DATA_STORE_LIMITS.maxListLimit);
}

export function normalizeOffset(value: unknown): number {
  const offset = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!Number.isInteger(offset) || offset < 0) throw new DataStoreValidationError("INVALID_OFFSET", "Data Store offset must be a non-negative integer.");
  return offset;
}

export function normalizeSortBy(value: unknown): DataStoreSortBy {
  if (value === "createdAt" || value === "updatedAt" || value === "key") return value;
  return "key";
}

export function normalizeSortDirection(value: unknown): DataStoreSortDirection {
  return value === "desc" ? "desc" : "asc";
}

export function normalizeUpsertMode(value: unknown): DataStoreUpsertMode {
  return value === "merge" ? "merge" : "replace";
}

export function mergeJsonObjects(existing: unknown, incoming: unknown): unknown {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) {
    throw new DataStoreValidationError("MERGE_REQUIRES_OBJECTS", "Data Store merge mode requires existing and incoming values to be JSON objects.");
  }
  return assertDataStoreValue({ ...existing, ...incoming });
}

export function dataStorePreview(value: unknown, maxBytes = 2_048): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxBytes) return value;
  return { truncated: true, originalSize: serialized.length, preview: serialized.slice(0, maxBytes) };
}

function assertSafeJson(value: unknown, options: { maxBytes: number; label: string }) {
  let operations = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number) => {
    operations += 1;
    if (operations > 10_000) throw new DataStoreValidationError("LIMIT_EXCEEDED", `Data Store ${options.label} is too complex.`);
    if (depth > DATA_STORE_LIMITS.maxDepth) throw new DataStoreValidationError("LIMIT_EXCEEDED", `Data Store ${options.label} exceeds maximum JSON depth.`);
    if (entry === undefined || typeof entry === "function" || typeof entry === "bigint" || typeof entry === "symbol") {
      throw new DataStoreValidationError("VALUE_NOT_JSON", `Data Store ${options.label} must be valid JSON.`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new DataStoreValidationError("VALUE_NOT_JSON", `Data Store ${options.label} numbers must be finite.`);
    }
    if (typeof entry === "string" && entry.length > DATA_STORE_LIMITS.maxStringLength) {
      throw new DataStoreValidationError("LIMIT_EXCEEDED", `Data Store ${options.label} string exceeds maximum length.`);
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) throw new DataStoreValidationError("VALUE_NOT_JSON", `Data Store ${options.label} cannot contain circular references.`);
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > DATA_STORE_LIMITS.maxArrayItems) throw new DataStoreValidationError("LIMIT_EXCEEDED", `Data Store ${options.label} array has too many items.`);
      entry.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isPlainObject(entry)) throw new DataStoreValidationError("VALUE_NOT_JSON", `Data Store ${options.label} must contain plain JSON objects only.`);
    for (const [key, item] of Object.entries(entry)) {
      if (DATA_STORE_DANGEROUS_KEYS.has(key)) throw new DataStoreValidationError("DANGEROUS_KEY", `Data Store key "${key}" is not allowed.`);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized.length > options.maxBytes) throw new DataStoreValidationError("LIMIT_EXCEEDED", `Data Store ${options.label} exceeds maximum size.`);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
