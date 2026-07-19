import { extractExpressionReferences } from "@automation/expression-engine";

export type DiffSeverity = "SAFE" | "WARNING" | "BREAKING";
export type FieldChange = { fieldPath: string; changeType: "ADDED" | "REMOVED" | "MODIFIED"; before?: unknown; after?: unknown; sensitive?: boolean; changed?: true };
export type DiffFinding = { severity: DiffSeverity; code: string; message: string; stepKey?: string };

const SENSITIVE = new Set(["authorization", "proxyauthorization", "cookie", "setcookie", "password", "pass", "token", "accesstoken", "refreshtoken", "apikey", "xapikey", "secret", "secretvalue", "clientsecret", "credentials", "connectionstring", "smtppassword", "privatekey", "encryptedvalue", "ciphertext", "authtag", "encryptionkey"]);
const SIDE_EFFECTS = new Set(["http_request", "email_notification", "database_record", "data_store_upsert_record", "data_store_delete_record", "execute_workflow", "approval"]);
const CONTROL = new Set(["for_each", "try_catch", "if", "switch", "approval"]);

export function workflowVersionDiff(fromRaw: unknown, toRaw: unknown, triggerSnapshots?: { from?: unknown; to?: unknown }) {
  const from = normalizeDefinition(fromRaw);
  const to = normalizeDefinition(toRaw);
  const fromSteps = new Map(from.steps.map((step: any) => [step.key, step]));
  const toSteps = new Map(to.steps.map((step: any) => [step.key, step]));
  const added = [...toSteps.keys()].filter((key) => !fromSteps.has(key)).map((key) => safeStep(toSteps.get(key)));
  const removed = [...fromSteps.keys()].filter((key) => !toSteps.has(key)).map((key) => safeStep(fromSteps.get(key)));
  const modified: any[] = [];
  for (const [key, before] of fromSteps) {
    const after = toSteps.get(key);
    if (!after) continue;
    const changes = diffFields(before, after, "", 0);
    if (changes.length) modified.push({ stepKey: key, beforeType: (before as any).type, afterType: (after as any).type, changes });
  }
  const fromEdges = edgeMap(from.graph?.edges ?? legacyEdges(from.steps));
  const toEdges = edgeMap(to.graph?.edges ?? legacyEdges(to.steps));
  const edgesAdded = [...toEdges].filter(([key]) => !fromEdges.has(key)).map(([, edge]) => edge);
  const edgesRemoved = [...fromEdges].filter(([key]) => !toEdges.has(key)).map(([, edge]) => edge);
  const triggerChanges = diffFields(from.trigger, to.trigger, "trigger", 0);
  const variableChanges = diffFields(from.workflowVariables, to.workflowVariables, "workflowVariables", 0);
  const environmentChanges = diffFields(from.environmentVariables, to.environmentVariables, "environmentVariables", 0);
  const controlChanges = diffFields({ entryStepKey: from.graph?.entryStepKey, terminalStepKeys: from.graph?.terminalStepKeys }, { entryStepKey: to.graph?.entryStepKey, terminalStepKeys: to.graph?.terminalStepKeys }, "graph", 0);
  const materializedTriggerChanges = triggerSnapshots ? diffFields(triggerSnapshots.from, triggerSnapshots.to, "materializedTriggers", 0) : [];
  const findings = findingsFor({ from, to, removed, modified, edgesAdded, edgesRemoved, triggerChanges, variableChanges, environmentChanges, controlChanges, materializedTriggerChanges });
  const maxSeverity = maximumSeverity(findings);
  const groups = {
    STEPS_ADDED: added, STEPS_REMOVED: removed, STEPS_MODIFIED: modified,
    EDGES_ADDED: edgesAdded, EDGES_REMOVED: edgesRemoved, TRIGGER_CHANGED: triggerChanges,
    VARIABLES_CHANGED: variableChanges, ENVIRONMENT_CHANGED: environmentChanges,
    CONTROL_FLOW_CHANGED: controlChanges, MATERIALIZED_TRIGGERS_CHANGED: materializedTriggerChanges
  };
  return { summary: { maxSeverity, totalChanges: Object.values(groups).reduce((sum, entries) => sum + entries.length, 0), heuristic: true }, groups, findings };
}

export function normalizeDefinition(raw: unknown): any {
  const value = record(raw);
  const steps = Array.isArray(value.steps) ? value.steps.map((step) => {
    const row = record(step);
    const { id: _id, position: _position, ...semantic } = row;
    return canonical(semantic);
  }) : [];
  const graph = record(value.graph);
  return canonical({
    trigger: record(value.trigger), steps,
    workflowDefinitionSchemaVersion: value.workflowDefinitionSchemaVersion ?? (Object.keys(graph).length ? 2 : 1),
    expressionMode: value.expressionMode ?? "legacy",
    workflowVariables: record(value.workflowVariables), environmentVariables: record(value.environmentVariables),
    graph: Object.keys(graph).length ? { ...graph, edges: [...(Array.isArray(graph.edges) ? graph.edges : [])].map(canonical).sort((a: any, b: any) => edgeKey(a).localeCompare(edgeKey(b))), terminalStepKeys: [...(Array.isArray(graph.terminalStepKeys) ? graph.terminalStepKeys : [])].sort() } : undefined
  });
}

export function diffFields(before: unknown, after: unknown, path = "", depth = 0): FieldChange[] {
  if (equal(before, after)) return [];
  if (depth >= 12 || !isContainer(before) || !isContainer(after) || Array.isArray(before) !== Array.isArray(after)) return [fieldChange(path || "$", before, after)];
  const changes: FieldChange[] = [];
  const keys = Array.isArray(before) && Array.isArray(after)
    ? Array.from({ length: Math.max(before.length, after.length) }, (_, index) => String(index))
    : [...new Set([...Object.keys(record(before)), ...Object.keys(record(after))])].sort();
  for (const key of keys) {
    if (changes.length >= 500) break;
    const beforeHas = key in (before as any); const afterHas = key in (after as any);
    const nextPath = path ? `${path}.${key}` : key;
    if (!beforeHas) changes.push(fieldChange(nextPath, undefined, (after as any)[key]));
    else if (!afterHas) changes.push(fieldChange(nextPath, (before as any)[key], undefined));
    else changes.push(...diffFields((before as any)[key], (after as any)[key], nextPath, depth + 1));
  }
  return changes.slice(0, 500);
}

function fieldChange(fieldPath: string, before: unknown, after: unknown): FieldChange {
  const changeType = before === undefined ? "ADDED" : after === undefined ? "REMOVED" : "MODIFIED";
  if (sensitivePath(fieldPath)) return { fieldPath, changeType, sensitive: true, changed: true };
  return { fieldPath, changeType, ...(before !== undefined ? { before: safeValue(before) } : {}), ...(after !== undefined ? { after: safeValue(after) } : {}) };
}

function findingsFor(input: any): DiffFinding[] {
  const findings: DiffFinding[] = [];
  const removedKeys = new Set(input.removed.map((step: any) => step.key));
  const references = input.to.steps.flatMap((step: any) => extractExpressionReferences(step.config).filter((ref) => ref.namespace === "steps").map((ref) => ({ consumer: step.key, producer: ref.segments[1] })));
  for (const step of input.removed) {
    const dependants = references.filter((ref: any) => ref.producer === step.key);
    findings.push({ severity: dependants.length || step.type === "return_workflow_output" ? "BREAKING" : "WARNING", code: dependants.length ? "REFERENCED_STEP_REMOVED" : "STEP_REMOVED", message: dependants.length ? `Removed step ${step.key} is referenced by ${dependants.map((item: any) => item.consumer).join(", ")}.` : `Step ${step.key} was removed.`, stepKey: step.key });
  }
  for (const step of input.modified) {
    if (step.beforeType !== step.afterType) findings.push({ severity: "BREAKING", code: "STEP_TYPE_CHANGED", message: `Step ${step.stepKey} changed type.`, stepKey: step.stepKey });
    else if (step.afterType === "execute_workflow" && step.changes.some((change: FieldChange) => ["config.workflowId", "config.workflowVersionId", "config.versionPolicy"].includes(change.fieldPath))) findings.push({ severity: "BREAKING", code: "SUBWORKFLOW_SELECTOR_CHANGED", message: `Subworkflow selector ${step.stepKey} changed.`, stepKey: step.stepKey });
    else if (["for_each", "try_catch"].includes(step.afterType) && step.changes.some((change: FieldChange) => change.fieldPath.startsWith("config."))) findings.push({ severity: "BREAKING", code: "CONTROL_STRUCTURE_CHANGED", message: `Control structure ${step.stepKey} changed.`, stepKey: step.stepKey });
    else if (CONTROL.has(step.afterType) && step.changes.some((change: FieldChange) => change.fieldPath !== "name")) findings.push({ severity: "WARNING", code: "CONTROL_CONFIG_CHANGED", message: `Control-flow step ${step.stepKey} changed.`, stepKey: step.stepKey });
    else if (SIDE_EFFECTS.has(step.afterType)) findings.push({ severity: "WARNING", code: "SIDE_EFFECT_CONFIG_CHANGED", message: `Side-effect step ${step.stepKey} changed.`, stepKey: step.stepKey });
    else if (step.changes.some((change: FieldChange) => /connectionId|dataStore(Id|Name)/.test(change.fieldPath))) findings.push({ severity: "WARNING", code: "RESOURCE_SELECTOR_CHANGED", message: `Resource selector in ${step.stepKey} changed.`, stepKey: step.stepKey });
  }
  if (input.triggerChanges.length) findings.push({ severity: "BREAKING", code: "TRIGGER_CHANGED", message: "The logical workflow trigger changed." });
  if (input.edgesRemoved.length) findings.push({ severity: "BREAKING", code: "EDGE_REMOVED", message: "One or more control-flow edges were removed." });
  if (input.edgesAdded.length) findings.push({ severity: "WARNING", code: "EDGE_ADDED", message: "One or more control-flow edges were added." });
  if (input.controlChanges.length) findings.push({ severity: "BREAKING", code: "GRAPH_CONTRACT_CHANGED", message: "The workflow entrypoint or terminal set changed." });
  for (const change of input.variableChanges.filter((item: FieldChange) => item.changeType === "REMOVED")) findings.push({ severity: "BREAKING", code: "VARIABLE_REMOVED", message: `${change.fieldPath} was removed.` });
  if (input.variableChanges.some((item: FieldChange) => item.changeType !== "REMOVED")) findings.push({ severity: "WARNING", code: "VARIABLE_CHANGED", message: "Workflow variables changed." });
  if (input.environmentChanges.length) findings.push({ severity: "WARNING", code: "ENVIRONMENT_CHANGED", message: "Workflow environment values changed." });
  if (input.materializedTriggerChanges.length) findings.push({ severity: "WARNING", code: "MATERIALIZED_TRIGGER_CHANGED", message: "The recorded materialized trigger configuration changed." });
  if (!findings.length && (removedKeys.size || input.modified.length)) findings.push({ severity: "SAFE", code: "NON_BREAKING_CHANGE", message: "Only non-breaking changes were detected." });
  return findings;
}

function maximumSeverity(findings: DiffFinding[]): DiffSeverity { return findings.some((x) => x.severity === "BREAKING") ? "BREAKING" : findings.some((x) => x.severity === "WARNING") ? "WARNING" : "SAFE"; }
function legacyEdges(steps: any[]) { return steps.slice(0, -1).map((step, index) => ({ from: step.key, to: steps[index + 1].key, kind: "next" })); }
function edgeMap(edges: any[]) { return new Map(edges.map((edge) => [edgeKey(edge), safeValue(edge)])); }
function edgeKey(edge: any) { return `${edge.from ?? ""}|${edge.to ?? ""}|${edge.kind ?? "next"}|${edge.caseKey ?? ""}`; }
function safeStep(step: any) { return { key: step.key, name: step.name, type: step.type }; }
function sensitivePath(path: string) { return path.split(".").some((part) => SENSITIVE.has(part.toLowerCase().replace(/[-_ ]/g, ""))); }
function safeValue(value: unknown) { const serialized = JSON.stringify(value); if (serialized && serialized.length > 4096) return { truncated: true, preview: serialized.slice(0, 4096) }; return value; }
function canonical(value: any): any { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function equal(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function isContainer(value: unknown) { return Boolean(value && typeof value === "object"); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
