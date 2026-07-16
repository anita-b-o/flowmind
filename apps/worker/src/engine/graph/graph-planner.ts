import { StepExecutionStatus } from "@automation/shared-types";
import { descendants, outgoingEdges, type RuntimeGraph } from "./graph-validator";

export type GraphStepState = {
  key: string;
  status?: string;
  outputJson?: unknown;
};

export function selectedNextStepKey(graph: RuntimeGraph, stepKey: string, outputJson: unknown) {
  const output = asRecord(outputJson);
  const explicit = typeof output.nextStepKey === "string" ? output.nextStepKey : undefined;
  if (explicit) return explicit;
  const next = outgoingEdges(graph, stepKey).find((edge) => edge.kind === "next");
  return next?.to;
}

export function branchSkipKeys(graph: RuntimeGraph, stepKey: string, selectedStepKey: string) {
  const skipped = new Set<string>();
  const reachableFromSelected = descendants(graph, selectedStepKey);
  reachableFromSelected.add(selectedStepKey);
  for (const edge of outgoingEdges(graph, stepKey)) {
    if (edge.to === selectedStepKey) continue;
    skipped.add(edge.to);
    for (const child of descendants(graph, edge.to)) {
      if (!reachableFromSelected.has(child)) skipped.add(child);
    }
  }
  skipped.delete(selectedStepKey);
  return [...skipped];
}

export function isTerminal(graph: RuntimeGraph, stepKey: string) {
  return Boolean(graph.terminalStepKeys?.includes(stepKey)) || outgoingEdges(graph, stepKey).length === 0;
}

export function isDone(status?: string) {
  return status === StepExecutionStatus.Completed || status === StepExecutionStatus.Skipped;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
