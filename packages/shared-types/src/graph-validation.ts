export type GraphValidationSeverity = "error" | "warning";

export type GraphValidationIssue = {
  code: string;
  message: string;
  severity: GraphValidationSeverity;
  stepKey?: string;
  edgeId?: string;
  handle?: string;
};

export type GraphStepLike = {
  id?: string;
  key: string;
  type: string;
  config: Record<string, unknown>;
};

export type GraphEdgeLike = {
  from?: unknown;
  to?: unknown;
  kind?: unknown;
  label?: unknown;
  caseKey?: unknown;
};

export type GraphLike = {
  entryStepKey?: unknown;
  edges?: unknown;
  terminalStepKeys?: unknown;
};

const EDGE_KINDS = new Set(["next", "if_true", "if_false", "switch_case", "switch_default"]);
const STEP_TYPES = {
  If: "if",
  Switch: "switch",
  Delay: "delay",
  WaitUntil: "wait_until"
} as const;
const CONTROL_TYPES = new Set([STEP_TYPES.If, STEP_TYPES.Switch]);
const DURATION_PATTERN = /^\s*([1-9][0-9]*)\s+(second|seconds|minute|minutes|hour|hours)\s*$/i;

export function validateGraphV2(steps: GraphStepLike[], graph: GraphLike | undefined): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  if (!graph || typeof graph !== "object") {
    return [issue("missing_graph", "Workflow graph is required for schema version 2.")];
  }

  const stepKeys = steps.map((step) => step.key);
  const stepKeySet = new Set<string>();
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id ?? "")) {
      issues.push(issue("duplicate_step_id", "Step IDs must be unique.", step.key));
    }
    if (step.id) stepIds.add(step.id);
    if (stepKeySet.has(step.key)) {
      issues.push(issue("duplicate_step_key", "Step keys must be unique.", step.key));
    }
    stepKeySet.add(step.key);
  }

  if (!steps.length) {
    issues.push(issue("empty_graph", "Workflow graph must contain at least one step."));
  }

  const entryStepKey = stringValue(graph.entryStepKey);
  if (!entryStepKey || !stepKeySet.has(entryStepKey)) {
    issues.push(issue("invalid_entry", "Workflow graph entryStepKey must reference an existing step."));
  }

  const edges = normalizedEdges(graph);
  const seenEdges = new Set<string>();
  const handles = new Map<string, GraphEdgeLike>();
  for (const edge of edges) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    const kind = stringValue(edge.kind);
    const edgeKey = edgeId(edge);
    if (seenEdges.has(edgeKey)) {
      issues.push(issue("duplicate_edge", "Workflow graph contains a duplicate edge.", from, edgeKey, handleForKind(kind, edge)));
    }
    seenEdges.add(edgeKey);
    if (!from || !to || !stepKeySet.has(from) || !stepKeySet.has(to) || !EDGE_KINDS.has(kind ?? "")) {
      issues.push(issue("invalid_edge", "Workflow graph contains an invalid edge.", from, edgeKey, handleForKind(kind, edge)));
      continue;
    }
    if (from === to) {
      issues.push(issue("self_loop", "A step cannot connect to itself.", from, edgeKey, handleForKind(kind, edge)));
    }
    const handle = handleForKind(kind, edge);
    const handleKey = `${from}:${handle}`;
    if (handles.has(handleKey)) {
      issues.push(issue("duplicate_output", "This output can only connect to one target.", from, edgeKey, handle));
    }
    handles.set(handleKey, edge);
  }

  if (!issues.some((entry) => entry.code === "invalid_edge")) {
    issues.push(...acyclicIssues(stepKeys, edges));
    if (entryStepKey) issues.push(...reachableIssues(entryStepKey, stepKeys, edges));
  }

  for (const step of steps) {
    if (step.type === STEP_TYPES.If) validateIf(step, stepKeySet, edges, issues);
    else if (step.type === STEP_TYPES.Switch) validateSwitch(step, stepKeySet, edges, issues);
    else {
      validateNonControl(step, edges, issues);
    }
    if (step.type === STEP_TYPES.Delay) validateDelay(step, issues);
    if (step.type === STEP_TYPES.WaitUntil) validateWaitUntil(step, issues);
  }

  return issues;
}

export function graphAvailableStepKeys(currentStepKey: string, steps: GraphStepLike[], graph: GraphLike | undefined) {
  if (!graph || !Array.isArray(graph.edges)) {
    const index = steps.findIndex((step) => step.key === currentStepKey);
    return index > 0 ? steps.slice(0, index).map((step) => step.key) : [];
  }
  const reverse = new Map<string, string[]>();
  for (const edge of normalizedEdges(graph)) {
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

function validateIf(step: GraphStepLike, stepKeys: Set<string>, edges: GraphEdgeLike[], issues: GraphValidationIssue[]) {
  const outgoing = outgoingEdges(step.key, edges);
  const trueStepKey = stringValue(step.config.trueStepKey);
  const falseStepKey = stringValue(step.config.falseStepKey);
  if (!trueStepKey || !stepKeys.has(trueStepKey) || trueStepKey === step.key) issues.push(issue("invalid_if_true", "If true branch must reference an existing step.", step.key, undefined, "true"));
  if (!falseStepKey || !stepKeys.has(falseStepKey) || falseStepKey === step.key) issues.push(issue("invalid_if_false", "If false branch must reference an existing step.", step.key, undefined, "false"));
  if (!outgoing.some((edge) => stringValue(edge.kind) === "if_true")) issues.push(issue("missing_if_true_edge", "If true branch is not connected.", step.key, undefined, "true"));
  if (!outgoing.some((edge) => stringValue(edge.kind) === "if_false")) issues.push(issue("missing_if_false_edge", "If false branch is not connected.", step.key, undefined, "false"));
  for (const edge of outgoing) {
    if (!["if_true", "if_false"].includes(stringValue(edge.kind) ?? "")) issues.push(issue("invalid_if_edge", "If steps may only use true or false graph edges.", step.key, edgeId(edge), handleForKind(stringValue(edge.kind), edge)));
  }
}

function validateSwitch(step: GraphStepLike, stepKeys: Set<string>, edges: GraphEdgeLike[], issues: GraphValidationIssue[]) {
  const outgoing = outgoingEdges(step.key, edges);
  const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
  const caseKeys = new Set<string>();
  const caseMatches = new Set<string>();
  if (!cases.length) issues.push(issue("missing_switch_cases", "Switch must define at least one case.", step.key));
  for (const entry of cases) {
    const key = stringValue(entry.key);
    const match = String(entry.match ?? "");
    const target = stringValue(entry.stepKey);
    if (!key || caseKeys.has(key)) issues.push(issue("invalid_switch_case_key", "Switch case keys must be unique.", step.key));
    if (key) caseKeys.add(key);
    if (match && caseMatches.has(match)) issues.push(issue("duplicate_switch_case_match", "Switch case match values must be unique.", step.key, undefined, key ? `case:${key}` : undefined));
    if (match) caseMatches.add(match);
    if (!target || !stepKeys.has(target) || target === step.key) issues.push(issue("invalid_switch_case_target", "Switch case target must reference an existing step.", step.key, undefined, key ? `case:${key}` : undefined));
    if (key && !outgoing.some((edge) => stringValue(edge.kind) === "switch_case" && stringValue(edge.caseKey) === key)) {
      issues.push(issue("missing_switch_case_edge", `Switch case "${key}" is not connected.`, step.key, undefined, `case:${key}`));
    }
  }
  const defaultStepKey = stringValue(step.config.defaultStepKey);
  if (!defaultStepKey || !stepKeys.has(defaultStepKey) || defaultStepKey === step.key) issues.push(issue("invalid_switch_default", "Switch default branch must reference an existing step.", step.key, undefined, "default"));
  if (!outgoing.some((edge) => stringValue(edge.kind) === "switch_default")) issues.push(issue("missing_switch_default_edge", "Switch default branch is not connected.", step.key, undefined, "default"));
  for (const edge of outgoing) {
    const kind = stringValue(edge.kind);
    if (kind === "switch_case" && !caseKeys.has(stringValue(edge.caseKey) ?? "")) issues.push(issue("orphan_switch_case_edge", "Switch case edge references a missing case.", step.key, edgeId(edge), handleForKind(kind, edge)));
    if (!["switch_case", "switch_default"].includes(kind ?? "")) issues.push(issue("invalid_switch_edge", "Switch steps may only use case or default graph edges.", step.key, edgeId(edge), handleForKind(kind, edge)));
  }
}

function validateNonControl(step: GraphStepLike, edges: GraphEdgeLike[], issues: GraphValidationIssue[]) {
  for (const edge of outgoingEdges(step.key, edges)) {
    if (stringValue(edge.kind) !== "next") issues.push(issue("invalid_non_control_edge", "This step can only use next edges.", step.key, edgeId(edge), handleForKind(stringValue(edge.kind), edge)));
  }
}

function validateDelay(step: GraphStepLike, issues: GraphValidationIssue[]) {
  const duration = step.config.duration;
  if (typeof duration !== "string" && typeof duration !== "number") issues.push(issue("invalid_delay_duration", "Delay duration is required.", step.key));
  if (typeof duration === "number" && (!Number.isFinite(duration) || duration <= 0)) issues.push(issue("invalid_delay_duration", "Delay duration must be positive.", step.key));
  if (typeof duration === "string" && !duration.includes("{{") && !DURATION_PATTERN.test(duration)) issues.push(issue("invalid_delay_duration", "Delay duration must use seconds, minutes, or hours.", step.key));
}

function validateWaitUntil(step: GraphStepLike, issues: GraphValidationIssue[]) {
  const timestamp = step.config.timestamp;
  if (typeof timestamp !== "string" || !timestamp.trim()) {
    issues.push(issue("invalid_wait_until_timestamp", "Wait Until timestamp is required.", step.key));
    return;
  }
  if (!timestamp.includes("{{") && !Number.isFinite(Date.parse(timestamp))) issues.push(issue("invalid_wait_until_timestamp", "Wait Until timestamp is invalid.", step.key));
}

function acyclicIssues(stepKeys: string[], edges: GraphEdgeLike[]) {
  const issues: GraphValidationIssue[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = adjacencyMap(edges);
  const visit = (key: string) => {
    if (visiting.has(key)) {
      issues.push(issue("cycle", "Workflow graph cannot contain cycles.", key));
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of adjacency.get(key) ?? []) visit(next);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of stepKeys) visit(key);
  return issues;
}

function reachableIssues(entryStepKey: string, stepKeys: string[], edges: GraphEdgeLike[]) {
  const adjacency = adjacencyMap(edges);
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of adjacency.get(key) ?? []) visit(next);
  };
  visit(entryStepKey);
  return stepKeys.filter((key) => !seen.has(key)).map((key) => issue("unreachable", "Step is unreachable from the entry step.", key));
}

function normalizedEdges(graph: GraphLike) {
  return Array.isArray(graph.edges) ? (graph.edges as GraphEdgeLike[]) : [];
}

function outgoingEdges(stepKey: string, edges: GraphEdgeLike[]) {
  return edges.filter((edge) => stringValue(edge.from) === stepKey);
}

function adjacencyMap(edges: GraphEdgeLike[]) {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    if (!from || !to) continue;
    map.set(from, [...(map.get(from) ?? []), to]);
  }
  return map;
}

function edgeId(edge: GraphEdgeLike) {
  return `${String(edge.from ?? "")}:${String(edge.kind ?? "")}:${String(edge.caseKey ?? "")}->${String(edge.to ?? "")}`;
}

function handleForKind(kind: string | undefined, edge: GraphEdgeLike) {
  if (kind === "if_true") return "true";
  if (kind === "if_false") return "false";
  if (kind === "switch_default") return "default";
  if (kind === "switch_case") return `case:${stringValue(edge.caseKey) ?? ""}`;
  return "next";
}

function issue(code: string, message: string, stepKey?: string, edgeId?: string, handle?: string): GraphValidationIssue {
  return { code, message, severity: "error", ...(stepKey ? { stepKey } : {}), ...(edgeId ? { edgeId } : {}), ...(handle ? { handle } : {}) };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
