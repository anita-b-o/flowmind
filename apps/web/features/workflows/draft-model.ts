import type { Edge, Node, Viewport } from "@xyflow/react";
import type { StepFormValue } from "./workflow-builder";
import type { StepType, WorkflowDefinitionUiDto, WorkflowGraphDto, WorkflowStepDto } from "./types";

export const TRIGGER_NODE_ID = "webhook";
export const TRIGGER_EDGE_ID = "webhook-entry";

export type DraftEdge = {
  source: string;
  sourceHandle: string;
  target: string;
};

export type WorkflowDraftModel = {
  workflowMeta: {
    name: string;
    description: string;
  };
  trigger: WorkflowStepDto;
  workflowVariables: Record<string, unknown>;
  environmentVariables: Record<string, unknown>;
  stepsByKey: Record<string, StepFormValue>;
  stepOrder: string[];
  edges: DraftEdge[];
  ui: WorkflowDefinitionUiDto;
  selectedStepKey?: string;
  validation: DraftValidationResult;
  dirty: {
    semantic: boolean;
    layout: boolean;
  };
  readOnly: boolean;
  sourceSchemaVersion: 1 | 2;
};

export type DraftValidationIssue = {
  code: string;
  message: string;
  stepKey?: string;
  edgeId?: string;
  handle?: string;
  severity: "error" | "warning";
};

export type DraftValidationResult = {
  issues: DraftValidationIssue[];
};

export type WorkflowNodeData = {
  label: string;
  stepKey: string;
  type: StepType | "webhook_trigger" | "subworkflow_trigger";
  summary: string;
  issues: DraftValidationIssue[];
  readOnly: boolean;
  debugStatus?: "active" | "completed" | "pending" | "skipped" | "failed" | "retrying" | "waiting" | "dlq";
  cases?: Array<{ key: string; label: string }>;
};

export type WorkflowFlowNode = Node<WorkflowNodeData>;
export type WorkflowFlowEdge = Edge<{ uiOnly?: boolean; label?: string; issues?: DraftValidationIssue[] }>;

export function graphKindToHandle(edge: WorkflowGraphDto["edges"][number]) {
  if (edge.kind === "if_true") return "true";
  if (edge.kind === "if_false") return "false";
  if (edge.kind === "switch_case") return `case:${edge.caseKey ?? edge.label ?? ""}`;
  if (edge.kind === "switch_default") return "default";
  if (edge.kind === "for_each_body") return "body";
  if (edge.kind === "for_each_done") return "done";
  if (edge.kind === "try_body") return "body";
  if (edge.kind === "try_catch") return "catch";
  if (edge.kind === "try_finally") return "finally";
  if (edge.kind === "try_done") return "done";
  if (edge.kind === "approval_approved") return "approved";
  if (edge.kind === "approval_rejected") return "rejected";
  if (edge.kind === "approval_expired") return "expired";
  return "next";
}

export function handleToGraphKind(handle: string, sourceType?: StepType): WorkflowGraphDto["edges"][number]["kind"] {
  if (handle === "true") return "if_true";
  if (handle === "false") return "if_false";
  if (handle === "default") return "switch_default";
  if (handle.startsWith("case:")) return "switch_case";
  if (sourceType === "try_catch") {
    if (handle === "body") return "try_body";
    if (handle === "catch") return "try_catch";
    if (handle === "finally") return "try_finally";
    if (handle === "done") return "try_done";
  }
  if (sourceType === "approval") {
    if (handle === "approved") return "approval_approved";
    if (handle === "rejected") return "approval_rejected";
    if (handle === "expired") return "approval_expired";
  }
  if (handle === "body") return "for_each_body";
  if (handle === "done") return "for_each_done";
  return "next";
}

export function edgeId(edge: DraftEdge) {
  return `${edge.source}:${edge.sourceHandle}->${edge.target}`;
}

export function caseKeyFromHandle(handle: string) {
  return handle.startsWith("case:") ? handle.slice("case:".length) : undefined;
}

export function isExclusiveHandle(handle: string) {
  return handle === "next" || handle === "true" || handle === "false" || handle === "default" || handle === "body" || handle === "catch" || handle === "finally" || handle === "done" || handle === "approved" || handle === "rejected" || handle === "expired" || handle.startsWith("case:");
}

export function sanitizeStepKey(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function generateStepKey(type: StepType, existing: Iterable<string>) {
  const used = new Set(existing);
  const base = sanitizeStepKey(type) || "step";
  let index = 1;
  let candidate = `${base}_${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

export function flowViewportToUi(viewport: Viewport) {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}
