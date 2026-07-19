import { BadRequestException } from "@nestjs/common";
import { StepType } from "@automation/shared-types";

export type DependencyKind = "CONNECTION" | "DATA_STORE" | "WORKFLOW";
export type DependencyClassification = "PORTABLE" | "REQUIRES_MAPPING" | "MISSING" | "UNSUPPORTED";
export type TemplateDependency = {
  dependencyKey: string;
  kind: DependencyKind;
  classification: DependencyClassification;
  stepKey: string;
  path: string;
  sourceReference?: { id?: string; name?: string; workflowVersionId?: string };
  expectedType?: string;
  message: string;
};
export type TriggerHint = { type: string; eventType?: string; httpMethod?: string; cron?: string; timezone?: string; executionPolicy?: string; config?: Record<string, unknown> };
export type DependencyManifest = { schemaVersion: 1; dependencies: TemplateDependency[]; triggerHints: TriggerHint[]; warnings: string[] };
export type Mapping = { dependencyKey: string; targetResourceId: string; targetWorkflowVersionId?: string };

const SENSITIVE = new Set(["authorization", "cookie", "setcookie", "password", "smtppassword", "token", "tokenhash", "tokenpreview", "secret", "secretvalue", "apikey", "xapikey", "credentials", "connectionstring", "encryptedvalue", "ciphertext", "authtag", "iv", "privatekey"]);
const OPERATIONAL_TRIGGER = new Set(["id", "enabled", "paused", "createdat", "updatedat", "rotatedat", "deletedat", "lastreceivedat", "lastexecutionid", "lastrunat", "nextrunat", "tokenhash", "tokenpreview"]);

export function normalizePortableDefinition(value: unknown): Record<string, unknown> {
  const definition = cloneRecord(value, "Workflow definition is invalid");
  const trigger = cloneRecord(definition.trigger, "Workflow trigger is invalid");
  const steps = Array.isArray(definition.steps) ? definition.steps.map((step) => cloneRecord(step, "Workflow step is invalid")) : [];
  delete trigger.id;
  for (const step of steps) delete step.id;
  const normalized: Record<string, unknown> = {
    trigger,
    steps,
    expressionMode: definition.expressionMode ?? "strict",
    workflowDefinitionSchemaVersion: definition.workflowDefinitionSchemaVersion ?? (definition.graph ? 2 : 1),
    workflowVariables: cloneRecord(definition.workflowVariables ?? {}, "Workflow variables are invalid"),
    environmentVariables: cloneRecord(definition.environmentVariables ?? {}, "Environment variables are invalid")
  };
  if (definition.graph !== undefined) normalized.graph = jsonClone(definition.graph);
  if (definition.ui !== undefined) normalized.ui = jsonClone(definition.ui);
  assertSafeVariables(normalized.workflowVariables, "workflowVariables");
  assertSafeVariables(normalized.environmentVariables, "environmentVariables");
  assertNoSensitiveFields(normalized);
  return normalized;
}

export function extractDependencies(definition: Record<string, unknown>): TemplateDependency[] {
  const steps = Array.isArray(definition.steps) ? definition.steps as Record<string, unknown>[] : [];
  const result: TemplateDependency[] = [];
  for (const step of steps) {
    const key = String(step.key ?? "unknown");
    const type = String(step.type ?? "");
    const config = isRecord(step.config) ? step.config : {};
    const connectionId = text(config.connectionId);
    if (connectionId) result.push(dependency("CONNECTION", key, "config.connectionId", { id: connectionId }, type === StepType.EmailNotification ? "smtp" : "http_api_key"));
    if (isDataStoreStep(type)) {
      const id = text(config.dataStoreId);
      const name = text(config.dataStoreName);
      const dynamic = [config.dataStoreId, config.dataStoreName].some((entry) => typeof entry === "string" && entry.includes("{{"));
      result.push(dynamic
        ? dependency("DATA_STORE", key, id ? "config.dataStoreId" : "config.dataStoreName", undefined, undefined, "UNSUPPORTED", "Dynamic Data Store selectors cannot be mapped safely")
        : dependency("DATA_STORE", key, id ? "config.dataStoreId" : "config.dataStoreName", { ...(id ? { id } : {}), ...(name ? { name } : {}) }, undefined, id || name ? "REQUIRES_MAPPING" : "MISSING", id || name ? "Data Store mapping required" : "Data Store selector is missing"));
    }
    if (type === StepType.ExecuteWorkflow) {
      const workflowId = text(config.workflowId);
      result.push(dependency("WORKFLOW", key, "config.workflowId", workflowId ? { id: workflowId, ...(text(config.workflowVersionId) ? { workflowVersionId: text(config.workflowVersionId) } : {}) } : undefined, text(config.versionPolicy), workflowId ? "REQUIRES_MAPPING" : "MISSING", workflowId ? "Workflow target mapping required" : "Workflow target is missing"));
    }
  }
  return result;
}

export function safeTriggerHints(value: unknown): TriggerHint[] {
  if (!isRecord(value) || !Array.isArray(value.triggers)) return [];
  return value.triggers.filter(isRecord).map((trigger) => {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(trigger)) {
      const normalized = normalizeKey(key);
      if (OPERATIONAL_TRIGGER.has(normalized) || sensitiveKey(key)) continue;
      if (key === "config") result.config = scrubSafeObject(entry);
      else if (["type", "eventType", "httpMethod", "cron", "timezone", "executionPolicy"].includes(key) && typeof entry === "string") result[key] = entry;
    }
    return result as TriggerHint;
  }).filter((entry) => Boolean(entry.type));
}

export function applyMappings(definition: Record<string, unknown>, dependencies: TemplateDependency[], mappings: Mapping[]) {
  const output = jsonClone(definition);
  const byKey = new Map(mappings.map((mapping) => [mapping.dependencyKey, mapping]));
  const steps = output.steps as Record<string, unknown>[];
  for (const dependency of dependencies) {
    const mapping = byKey.get(dependency.dependencyKey);
    if (!mapping) continue;
    const step = steps.find((entry) => entry.key === dependency.stepKey);
    const config = step && isRecord(step.config) ? step.config : undefined;
    if (!config) continue;
    if (dependency.kind === "CONNECTION") config.connectionId = mapping.targetResourceId;
    if (dependency.kind === "DATA_STORE") { delete config.dataStoreName; config.dataStoreId = mapping.targetResourceId; }
    if (dependency.kind === "WORKFLOW") {
      config.workflowId = mapping.targetResourceId;
      if (config.versionPolicy === "PINNED_VERSION") config.workflowVersionId = mapping.targetWorkflowVersionId;
      else delete config.workflowVersionId;
    }
  }
  return output;
}

function dependency(kind: DependencyKind, stepKey: string, path: string, sourceReference?: { id?: string; name?: string; workflowVersionId?: string }, expectedType?: string, classification: DependencyClassification = "REQUIRES_MAPPING", message = `${kind} mapping required`): TemplateDependency {
  return { dependencyKey: `${kind}:${stepKey}:${path}`, kind, classification, stepKey, path, sourceReference, expectedType, message };
}
function assertSafeVariables(value: unknown, path: string) {
  if (!isRecord(value)) throw new BadRequestException(`${path} must be an object`);
  walk(value, path, true);
}
function assertNoSensitiveFields(value: unknown) { walk(value, "definition", false); }
function walk(value: unknown, path: string, variables: boolean) {
  if (typeof value === "string" && credentialShaped(value)) throw new BadRequestException(`Sensitive data is not portable (${path})`);
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey(key)) throw new BadRequestException(`Sensitive data is not portable (${path}.${key})`);
    walk(entry, `${path}.${key}`, variables);
  }
}
function scrubSafeObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !sensitiveKey(key) && !OPERATIONAL_TRIGGER.has(normalizeKey(key)) && !(typeof entry === "string" && credentialShaped(entry))).map(([key, entry]) => [key, scrubSafeValue(entry)]));
}
function scrubSafeValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(scrubSafeValue); if (isRecord(value)) return scrubSafeObject(value); if (typeof value === "string" && credentialShaped(value)) return "[removed]"; return value; }
function credentialShaped(value: string) { return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(value) || /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(value) || /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(value); }
function cloneRecord(value: unknown, message: string) { if (!isRecord(value)) throw new BadRequestException(message); return jsonClone(value); }
function jsonClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function normalizeKey(value: string) { return value.toLowerCase().replace(/[-_ ]/g, ""); }
function sensitiveKey(value: string) { const key = normalizeKey(value); return SENSITIVE.has(key) || /(token|password|secret|credential|authorization|cookie|connectionstring)$/.test(key); }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isDataStoreStep(type: string) { return type.startsWith("data_store_"); }
