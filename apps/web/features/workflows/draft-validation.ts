import type { DraftEdge, DraftValidationIssue, WorkflowDraftModel } from "./draft-model";
import { isExclusiveHandle } from "./draft-model";

const STEP_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateDraft(draft: WorkflowDraftModel) {
  const issues: DraftValidationIssue[] = [];
  const keys = draft.stepOrder;
  const keySet = new Set(keys);

  if (!keys.length) {
    issues.push({ code: "no_entry", message: "No entry step exists.", severity: "error" });
  }

  for (const key of keys) {
    const step = draft.stepsByKey[key];
    if (!step) {
      issues.push({ code: "missing_step", message: `Step "${key}" is missing from the draft.`, stepKey: key, severity: "error" });
      continue;
    }
    if (!STEP_KEY_PATTERN.test(key)) {
      issues.push({ code: "invalid_step_key", message: "Step key may only contain letters, numbers, _ or -.", stepKey: key, severity: "error" });
    }
  }

  const seenEdges = new Set<string>();
  const exclusive = new Map<string, DraftEdge>();
  for (const edge of draft.edges) {
    const id = `${edge.source}:${edge.sourceHandle}->${edge.target}`;
    if (seenEdges.has(id)) {
      issues.push({ code: "duplicate_edge", message: "Duplicate edge.", stepKey: edge.source, handle: edge.sourceHandle, severity: "error" });
    }
    seenEdges.add(id);
    if (edge.source === edge.target) {
      issues.push({ code: "self_loop", message: "A step cannot connect to itself.", stepKey: edge.source, handle: edge.sourceHandle, severity: "error" });
    }
    if (!keySet.has(edge.source) || !keySet.has(edge.target)) {
      issues.push({ code: "missing_edge_endpoint", message: "Edge references a missing step.", stepKey: edge.source, handle: edge.sourceHandle, severity: "error" });
    }
    if (isExclusiveHandle(edge.sourceHandle)) {
      const exclusiveKey = `${edge.source}:${edge.sourceHandle}`;
      if (exclusive.has(exclusiveKey)) {
        issues.push({ code: "exclusive_handle", message: "This output can only connect to one target.", stepKey: edge.source, handle: edge.sourceHandle, severity: "error" });
      }
      exclusive.set(exclusiveKey, edge);
    }
  }

  for (const key of keys) {
    const step = draft.stepsByKey[key];
    if (!step) continue;
    const outgoing = draft.edges.filter((edge) => edge.source === key);
    const incoming = draft.edges.filter((edge) => edge.target === key);
    if (key !== keys[0] && !incoming.length) {
      issues.push({ code: "disconnected", message: "Step has no incoming connection.", stepKey: key, severity: "warning" });
    }
    if (step.type === "if") {
      if (!outgoing.some((edge) => edge.sourceHandle === "true")) {
        issues.push({ code: "missing_true_branch", message: "If true branch is not connected.", stepKey: key, handle: "true", severity: "error" });
      }
      if (!outgoing.some((edge) => edge.sourceHandle === "false")) {
        issues.push({ code: "missing_false_branch", message: "If false branch is not connected.", stepKey: key, handle: "false", severity: "error" });
      }
    }
    if (step.type === "switch") {
      const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
      const caseKeys = new Set<string>();
      for (const entry of cases) {
        const caseKey = String(entry.key ?? "");
        if (!caseKey || caseKeys.has(caseKey)) {
          issues.push({ code: "invalid_switch_case", message: "Switch cases need stable unique keys.", stepKey: key, severity: "error" });
        }
        caseKeys.add(caseKey);
        if (!outgoing.some((edge) => edge.sourceHandle === `case:${caseKey}`)) {
          issues.push({ code: "missing_switch_case_target", message: `Switch case "${caseKey}" is not connected.`, stepKey: key, handle: `case:${caseKey}`, severity: "error" });
        }
      }
      if (!outgoing.some((edge) => edge.sourceHandle === "default")) {
        issues.push({ code: "missing_switch_default", message: "Switch default branch is not connected.", stepKey: key, handle: "default", severity: "error" });
      }
    }
  }

  if (hasCycle(keys, draft.edges)) {
    issues.push({ code: "cycle", message: "Workflow graph cannot contain cycles.", severity: "error" });
  }

  for (const key of unreachableKeys(keys[0], keys, draft.edges)) {
    issues.push({ code: "unreachable", message: "Step is unreachable from the entry step.", stepKey: key, severity: "error" });
  }

  return { issues };
}

export function wouldCreateCycle(draft: WorkflowDraftModel, edge: DraftEdge) {
  return hasCycle(draft.stepOrder, [...draft.edges, edge]);
}

function hasCycle(keys: string[], edges: DraftEdge[]) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = adjacencyMap(edges);
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const next of adjacency.get(key) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return keys.some((key) => visit(key));
}

function unreachableKeys(entry: string | undefined, keys: string[], edges: DraftEdge[]) {
  if (!entry) return keys;
  const adjacency = adjacencyMap(edges);
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of adjacency.get(key) ?? []) visit(next);
  };
  visit(entry);
  return keys.filter((key) => !seen.has(key));
}

function adjacencyMap(edges: DraftEdge[]) {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    map.set(edge.source, [...(map.get(edge.source) ?? []), edge.target]);
  }
  return map;
}
