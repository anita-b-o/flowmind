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

const EDGE_KINDS = new Set(["next", "if_true", "if_false", "switch_case", "switch_default", "for_each_body", "for_each_done"]);
const STEP_TYPES = {
  If: "if",
  Switch: "switch",
  Delay: "delay",
  WaitUntil: "wait_until",
  ForEach: "for_each"
} as const;
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
    else if (step.type === STEP_TYPES.ForEach) validateForEach(step, steps, stepKeySet, edges, issues);
    else {
      validateNonControl(step, edges, issues);
    }
    if (step.type === STEP_TYPES.Delay) validateDelay(step, issues);
    if (step.type === STEP_TYPES.WaitUntil) validateWaitUntil(step, issues);
  }

  return issues;
}

export type ForEachRegion = { loopStepKey: string; bodyEntryStepKey: string; doneStepKey: string; bodyStepKeys: Set<string> };

export function forEachRegions(steps: GraphStepLike[], graph: GraphLike | undefined): ForEachRegion[] {
  const edges = graph ? normalizedEdges(graph) : [];
  return steps.filter((step) => step.type === STEP_TYPES.ForEach).flatMap((step) => {
    const body = outgoingEdges(step.key, edges).find((edge) => stringValue(edge.kind) === "for_each_body");
    const done = outgoingEdges(step.key, edges).find((edge) => stringValue(edge.kind) === "for_each_done");
    const bodyEntryStepKey = stringValue(body?.to);
    const doneStepKey = stringValue(done?.to);
    if (!bodyEntryStepKey || !doneStepKey || bodyEntryStepKey === doneStepKey) return [];
    const bodyStepKeys = descendantsUntil(bodyEntryStepKey, doneStepKey, edges);
    return [{ loopStepKey: step.key, bodyEntryStepKey, doneStepKey, bodyStepKeys }];
  });
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

function validateForEach(step: GraphStepLike, steps: GraphStepLike[], stepKeys: Set<string>, edges: GraphEdgeLike[], issues: GraphValidationIssue[]) {
  const outgoing = outgoingEdges(step.key, edges);
  const bodyEdges = outgoing.filter((edge) => stringValue(edge.kind) === "for_each_body");
  const doneEdges = outgoing.filter((edge) => stringValue(edge.kind) === "for_each_done");
  if (bodyEdges.length !== 1) issues.push(issue("invalid_for_each_body", "FOR_EACH must have exactly one Body connection.", step.key, undefined, "body"));
  if (doneEdges.length !== 1) issues.push(issue("invalid_for_each_done", "FOR_EACH must have exactly one Done connection.", step.key, undefined, "done"));
  for (const edge of outgoing) {
    if (!["for_each_body", "for_each_done"].includes(stringValue(edge.kind) ?? "")) issues.push(issue("invalid_for_each_edge", "FOR_EACH may only use Body and Done edges.", step.key, edgeId(edge), handleForKind(stringValue(edge.kind), edge)));
  }
  validateForEachConfig(step, issues);
  if (bodyEdges.length !== 1 || doneEdges.length !== 1) return;
  const bodyEntry = stringValue(bodyEdges[0].to);
  const done = stringValue(doneEdges[0].to);
  if (!bodyEntry || !done || !stepKeys.has(bodyEntry) || !stepKeys.has(done)) return;
  if (bodyEntry === done) {
    issues.push(issue("empty_for_each_body", "FOR_EACH Body must contain at least one step before Done.", step.key, undefined, "body"));
    return;
  }
  const body = descendantsUntil(bodyEntry, done, edges);
  if (!body.size) issues.push(issue("empty_for_each_body", "FOR_EACH Body must contain at least one step before Done.", step.key, undefined, "body"));
  if (body.has(step.key)) issues.push(issue("for_each_back_edge", "FOR_EACH Body cannot return to the loop node.", step.key));
  for (const key of body) {
    const bodyStep = steps.find((candidate) => candidate.key === key);
    if (bodyStep?.type === STEP_TYPES.ForEach) issues.push(issue("nested_for_each", "Nested FOR_EACH loops are not supported.", key));
    if (!canReach(key, done, edges)) issues.push(issue("for_each_body_escape", "Every FOR_EACH Body path must converge on Done.", key));
    for (const edge of outgoingEdges(key, edges)) {
      const target = stringValue(edge.to);
      if (target && target !== done && !body.has(target)) issues.push(issue("for_each_body_escape", "FOR_EACH Body edges cannot escape the controlled region.", key, edgeId(edge)));
    }
  }
  for (const edge of edges) {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    if (!from || !to || !body.has(to) || body.has(from)) continue;
    if (!(from === step.key && to === bodyEntry && stringValue(edge.kind) === "for_each_body")) {
      issues.push(issue("for_each_external_entry", "FOR_EACH Body cannot receive external connections.", to, edgeId(edge)));
    }
  }
}

function validateForEachConfig(step: GraphStepLike, issues: GraphValidationIssue[]) {
  const config = step.config;
  if (config.source === undefined || config.source === null || config.source === "") issues.push(issue("invalid_for_each_source", "FOR_EACH Source is required.", step.key));
  if (config.mode !== undefined && config.mode !== "SEQUENTIAL") issues.push(issue("invalid_for_each_mode", "FOR_EACH only supports SEQUENTIAL mode.", step.key));
  if (config.concurrency !== undefined && Number(config.concurrency) !== 1) issues.push(issue("invalid_for_each_concurrency", "FOR_EACH concurrency must be 1.", step.key));
  const maxItems = Number(config.maxItems ?? 100);
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 1000) issues.push(issue("invalid_for_each_max_items", "FOR_EACH maxItems must be an integer between 0 and 1000.", step.key));
  const maxResults = Number(config.maxResults ?? 20);
  if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > 100) issues.push(issue("invalid_for_each_max_results", "FOR_EACH maxResults must be an integer between 0 and 100.", step.key));
  const aliases = [config.itemVariable, config.indexVariable].filter((value): value is string => typeof value === "string" && Boolean(value));
  if (new Set(aliases).size !== aliases.length) issues.push(issue("duplicate_for_each_alias", "FOR_EACH item and index aliases must be different.", step.key));
  for (const alias of aliases) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(alias) || ["item", "index", "__proto__", "prototype", "constructor"].includes(alias)) issues.push(issue("invalid_for_each_alias", "FOR_EACH aliases must be safe variable names.", step.key));
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

function descendantsUntil(start: string, stop: string, edges: GraphEdgeLike[]) {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (key === stop || seen.has(key)) return;
    seen.add(key);
    for (const edge of outgoingEdges(key, edges)) {
      const target = stringValue(edge.to);
      if (target) visit(target);
    }
  };
  visit(start);
  return seen;
}

function canReach(start: string, target: string, edges: GraphEdgeLike[]) {
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (key === target) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return outgoingEdges(key, edges).some((edge) => {
      const next = stringValue(edge.to);
      return next ? visit(next) : false;
    });
  };
  return visit(start);
}

function edgeId(edge: GraphEdgeLike) {
  return `${String(edge.from ?? "")}:${String(edge.kind ?? "")}:${String(edge.caseKey ?? "")}->${String(edge.to ?? "")}`;
}

function handleForKind(kind: string | undefined, edge: GraphEdgeLike) {
  if (kind === "if_true") return "true";
  if (kind === "if_false") return "false";
  if (kind === "switch_default") return "default";
  if (kind === "switch_case") return `case:${stringValue(edge.caseKey) ?? ""}`;
  if (kind === "for_each_body") return "body";
  if (kind === "for_each_done") return "done";
  return "next";
}

function issue(code: string, message: string, stepKey?: string, edgeId?: string, handle?: string): GraphValidationIssue {
  return { code, message, severity: "error", ...(stepKey ? { stepKey } : {}), ...(edgeId ? { edgeId } : {}), ...(handle ? { handle } : {}) };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
