import { BadRequestException } from "@nestjs/common";

type StepLike = { key: string; type: string; config: Record<string, unknown> };
type GraphEdge = { from?: unknown; to?: unknown; kind?: unknown; label?: unknown; caseKey?: unknown };
type GraphLike = { entryStepKey?: unknown; edges?: unknown; terminalStepKeys?: unknown };

const CONTROL_TYPES = new Set(["if", "switch"]);
const EDGE_KINDS = new Set(["next", "if_true", "if_false", "switch_case", "switch_default"]);
const DURATION_PATTERN = /^\s*([1-9][0-9]*)\s+(second|seconds|minute|minutes|hour|hours)\s*$/i;

export function validateWorkflowGraph(steps: StepLike[], graph: GraphLike | undefined) {
  if (!graph || typeof graph !== "object") {
    throw new BadRequestException("Workflow graph is required for schema version 2");
  }
  const stepKeys = new Set(steps.map((step) => step.key));
  if (stepKeys.size !== steps.length) {
    throw new BadRequestException("Workflow step keys must be unique");
  }
  const entryStepKey = stringValue(graph.entryStepKey);
  if (!entryStepKey || !stepKeys.has(entryStepKey)) {
    throw new BadRequestException("Workflow graph entryStepKey must reference an existing step");
  }
  const edges = Array.isArray(graph.edges) ? (graph.edges as GraphEdge[]) : [];
  for (const edge of edges) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    const kind = stringValue(edge.kind);
    if (!from || !to || !stepKeys.has(from) || !stepKeys.has(to) || from === to || !EDGE_KINDS.has(kind ?? "")) {
      throw new BadRequestException("Workflow graph contains an invalid edge");
    }
  }
  assertAcyclic(stepKeys, edges);
  assertReachable(entryStepKey, stepKeys, edges);
  for (const step of steps) {
    if (step.type === "if") validateIfStep(step, stepKeys, edges);
    if (step.type === "switch") validateSwitchStep(step, stepKeys, edges);
    if (step.type === "delay") validateDelayStep(step);
    if (step.type === "wait_until") validateWaitUntilStep(step);
    if (!CONTROL_TYPES.has(step.type)) validateNonControlEdges(step, edges);
  }
}

export function graphAvailableStepKeys(currentStepKey: string, steps: StepLike[], graph: GraphLike | undefined) {
  if (!graph || !Array.isArray(graph.edges)) {
    const index = steps.findIndex((step) => step.key === currentStepKey);
    return index > 0 ? steps.slice(0, index).map((step) => step.key) : [];
  }
  const reverse = new Map<string, string[]>();
  for (const edge of graph.edges as GraphEdge[]) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    if (!from || !to) continue;
    reverse.set(to, [...(reverse.get(to) ?? []), from]);
  }
  const seen = new Set<string>();
  const visit = (key: string) => {
    for (const parent of reverse.get(key) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      visit(parent);
    }
  };
  visit(currentStepKey);
  seen.delete(currentStepKey);
  return [...seen];
}

function validateIfStep(step: StepLike, stepKeys: Set<string>, edges: GraphEdge[]) {
  const trueStepKey = stringValue(step.config.trueStepKey);
  const falseStepKey = stringValue(step.config.falseStepKey);
  if (!trueStepKey || !falseStepKey || !stepKeys.has(trueStepKey) || !stepKeys.has(falseStepKey) || trueStepKey === step.key || falseStepKey === step.key) {
    throw new BadRequestException(`If step "${step.key}" must define valid true and false branches`);
  }
  const kinds = outgoing(step.key, edges).map((edge) => stringValue(edge.kind));
  if (!kinds.includes("if_true") || !kinds.includes("if_false")) {
    throw new BadRequestException(`If step "${step.key}" must have true and false graph edges`);
  }
}

function validateSwitchStep(step: StepLike, stepKeys: Set<string>, edges: GraphEdge[]) {
  const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
  const defaultStepKey = stringValue(step.config.defaultStepKey);
  if (!cases.length || !defaultStepKey || !stepKeys.has(defaultStepKey) || defaultStepKey === step.key) {
    throw new BadRequestException(`Switch step "${step.key}" must define cases and a valid default branch`);
  }
  for (const entry of cases) {
    const key = stringValue(entry.key);
    const stepKey = stringValue(entry.stepKey);
    if (!key || !stepKey || !stepKeys.has(stepKey) || stepKey === step.key) {
      throw new BadRequestException(`Switch step "${step.key}" contains an invalid case`);
    }
  }
  const kinds = outgoing(step.key, edges).map((edge) => stringValue(edge.kind));
  if (!kinds.includes("switch_default") || !kinds.includes("switch_case")) {
    throw new BadRequestException(`Switch step "${step.key}" must have case and default graph edges`);
  }
}

function validateDelayStep(step: StepLike) {
  const duration = step.config.duration;
  if (typeof duration !== "string" && typeof duration !== "number") {
    throw new BadRequestException(`Delay step "${step.key}" must define a duration`);
  }
  if (typeof duration === "number" && (!Number.isFinite(duration) || duration <= 0)) {
    throw new BadRequestException(`Delay step "${step.key}" duration must be positive`);
  }
  if (typeof duration === "string" && !duration.includes("{{") && !DURATION_PATTERN.test(duration)) {
    throw new BadRequestException(`Delay step "${step.key}" duration is invalid`);
  }
}

function validateWaitUntilStep(step: StepLike) {
  const timestamp = step.config.timestamp;
  if (typeof timestamp !== "string" || !timestamp.trim()) {
    throw new BadRequestException(`Wait Until step "${step.key}" must define a timestamp`);
  }
  if (!timestamp.includes("{{")) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) throw new BadRequestException(`Wait Until step "${step.key}" timestamp is invalid`);
  }
}

function validateNonControlEdges(step: StepLike, edges: GraphEdge[]) {
  const nonNext = outgoing(step.key, edges).filter((edge) => stringValue(edge.kind) !== "next");
  if (nonNext.length) {
    throw new BadRequestException(`Step "${step.key}" can only use next edges`);
  }
}

function assertAcyclic(stepKeys: Set<string>, edges: GraphEdge[]) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = adjacencyMap(edges);
  const visit = (key: string) => {
    if (visiting.has(key)) throw new BadRequestException("Workflow graph cannot contain cycles");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of adjacency.get(key) ?? []) visit(next);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of stepKeys) visit(key);
}

function assertReachable(entryStepKey: string, stepKeys: Set<string>, edges: GraphEdge[]) {
  const adjacency = adjacencyMap(edges);
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of adjacency.get(key) ?? []) visit(next);
  };
  visit(entryStepKey);
  for (const key of stepKeys) {
    if (!seen.has(key)) throw new BadRequestException(`Workflow graph step "${key}" is unreachable`);
  }
}

function adjacencyMap(edges: GraphEdge[]) {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    if (!from || !to) continue;
    map.set(from, [...(map.get(from) ?? []), to]);
  }
  return map;
}

function outgoing(stepKey: string, edges: GraphEdge[]) {
  return edges.filter((edge) => stringValue(edge.from) === stepKey);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
