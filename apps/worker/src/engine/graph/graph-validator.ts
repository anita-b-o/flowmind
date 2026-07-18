export type RuntimeGraph = {
  entryStepKey: string;
  edges: RuntimeGraphEdge[];
  terminalStepKeys?: string[];
};

export type RuntimeGraphEdge = {
  from: string;
  to: string;
  kind: "next" | "if_true" | "if_false" | "switch_case" | "switch_default" | "for_each_body" | "for_each_done" | "try_body" | "try_catch" | "try_finally" | "try_done";
  label?: string;
  caseKey?: string;
};

export function parseRuntimeGraph(definition: unknown): RuntimeGraph | null {
  const record = asRecord(definition);
  if (record.workflowDefinitionSchemaVersion !== 2) return null;
  const graph = asRecord(record.graph);
  const entryStepKey = typeof graph.entryStepKey === "string" ? graph.entryStepKey : "";
  const edges = Array.isArray(graph.edges)
    ? graph.edges
        .map((edge) => {
          const item = asRecord(edge);
          return {
            from: String(item.from ?? ""),
            to: String(item.to ?? ""),
            kind: String(item.kind ?? "") as RuntimeGraphEdge["kind"],
            label: typeof item.label === "string" ? item.label : undefined,
            caseKey: typeof item.caseKey === "string" ? item.caseKey : undefined
          };
        })
        .filter((edge) => edge.from && edge.to && ["next", "if_true", "if_false", "switch_case", "switch_default", "for_each_body", "for_each_done", "try_body", "try_catch", "try_finally", "try_done"].includes(edge.kind))
    : [];
  const terminalStepKeys = Array.isArray(graph.terminalStepKeys) ? graph.terminalStepKeys.filter((key): key is string => typeof key === "string") : undefined;
  return entryStepKey ? { entryStepKey, edges, terminalStepKeys } : null;
}

export function validateRuntimeGraph(graph: RuntimeGraph, stepKeys: Set<string>) {
  if (!stepKeys.has(graph.entryStepKey)) {
    throw new Error("Workflow graph entry step is invalid");
  }
  for (const edge of graph.edges) {
    if (!stepKeys.has(edge.from) || !stepKeys.has(edge.to) || edge.from === edge.to) {
      throw new Error("Workflow graph contains an invalid edge");
    }
  }
  assertAcyclic(graph, stepKeys);
}

export function outgoingEdges(graph: RuntimeGraph, stepKey: string) {
  return graph.edges.filter((edge) => edge.from === stepKey);
}

export function descendants(graph: RuntimeGraph, stepKey: string) {
  const seen = new Set<string>();
  const visit = (key: string) => {
    for (const edge of outgoingEdges(graph, key)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      visit(edge.to);
    }
  };
  visit(stepKey);
  return seen;
}

function assertAcyclic(graph: RuntimeGraph, stepKeys: Set<string>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("Workflow graph cannot contain cycles");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const edge of outgoingEdges(graph, key)) visit(edge.to);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of stepKeys) visit(key);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
