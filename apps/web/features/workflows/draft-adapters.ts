import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import {
  caseKeyFromHandle,
  edgeId,
  generateStepKey,
  graphKindToHandle,
  handleToGraphKind,
  TRIGGER_EDGE_ID,
  TRIGGER_NODE_ID,
  type DraftEdge,
  type WorkflowDraftModel,
  type WorkflowFlowEdge,
  type WorkflowFlowNode
} from "./draft-model";
import { ensureDraftLayout } from "./auto-layout";
import { validateDraft, wouldCreateCycle } from "./draft-validation";
import type { StepType, WorkflowDefinitionDto, WorkflowDetail, WorkflowGraphDto, WorkflowVersion } from "./types";
import { defaultConfig, defaultTimeout, emptyStep, formFromVersion, stepFormToDto, type StepFormValue, type WorkflowEditorFormValue } from "./workflow-builder";

export function workflowVersionToDraft(workflow: Pick<WorkflowDetail, "name" | "description">, version?: WorkflowVersion, readOnly = false): WorkflowDraftModel {
  const form = formFromVersion(workflow, version);
  const stepsByKey = Object.fromEntries(form.steps.map((step) => [step.key, step]));
  const stepOrder = form.steps.map((step) => step.key);
  const definition = version?.definitionJson;
  const schemaVersion = definition?.workflowDefinitionSchemaVersion ?? (definition?.graph ? 2 : 1);
  const graphEdges = schemaVersion === 2 && definition?.graph?.edges?.length ? definition.graph.edges.map(graphEdgeToDraftEdge) : linearEdges(stepOrder);
  const trigger = definition?.trigger ?? { key: TRIGGER_NODE_ID, name: "Webhook", type: "webhook_trigger" as const, config: {} };
  const base: WorkflowDraftModel = {
    workflowMeta: { name: form.name, description: form.description },
    trigger,
    stepsByKey,
    stepOrder,
    edges: graphEdges.filter((edge) => stepsByKey[edge.source] && stepsByKey[edge.target]),
    ui: definition?.ui ?? {},
    validation: { issues: [] },
    dirty: { semantic: false, layout: false },
    readOnly,
    sourceSchemaVersion: schemaVersion
  };
  return withValidation(ensureDraftLayout(base));
}

export function draftToFormValue(draft: WorkflowDraftModel): WorkflowEditorFormValue {
  return {
    name: draft.workflowMeta.name,
    description: draft.workflowMeta.description,
    steps: draft.stepOrder.map((key) => routeStepFromEdges(draft.stepsByKey[key], draft.edges)).filter(Boolean) as StepFormValue[]
  };
}

export function formValueToDraft(form: WorkflowEditorFormValue, draft: WorkflowDraftModel): WorkflowDraftModel {
  const stepsByKey = Object.fromEntries(form.steps.map((step) => [step.key, step]));
  const stepOrder = form.steps.map((step) => step.key);
  const stepKeys = new Set(stepOrder);
  const edges = formToDraftEdges(form.steps).filter((edge) => stepKeys.has(edge.source) && stepKeys.has(edge.target));
  return withValidation({
    ...draft,
    workflowMeta: { name: form.name, description: form.description },
    stepsByKey,
    stepOrder,
    edges,
    dirty: { ...draft.dirty, semantic: true }
  });
}

export function draftToWorkflowDefinitionDto(draft: WorkflowDraftModel): WorkflowDefinitionDto {
  const form = draftToFormValue(draft);
  const graph = draftToGraph(draft);
  const subworkflow = form.steps.some((step) => step.type === "return_workflow_output");
  return {
    trigger: subworkflow ? { key: "subworkflow", name: "Subworkflow Input", type: "subworkflow_trigger", config: {} } : draft.trigger,
    steps: form.steps.map((step, index) => stepFormToDto(step, index)),
    expressionMode: "strict",
    workflowDefinitionSchemaVersion: 2,
    workflowVariables: {},
    environmentVariables: {},
    graph,
    ui: draft.ui
  };
}

export function draftToGraph(draft: WorkflowDraftModel): WorkflowGraphDto {
  const edges = draft.edges.map((edge) => {
    const kind = handleToGraphKind(edge.sourceHandle, draft.stepsByKey[edge.source]?.type);
    return {
      from: edge.source,
      to: edge.target,
      kind,
      ...(edge.sourceHandle === "true" ? { label: "true" } : {}),
      ...(edge.sourceHandle === "false" ? { label: "false" } : {}),
      ...(edge.sourceHandle === "default" ? { label: "default" } : {}),
      ...(kind === "switch_case" ? switchCaseMetadata(draft.stepsByKey[edge.source], edge.sourceHandle) : {})
    };
  });
  const outgoing = new Set(edges.map((edge) => edge.from));
  return {
    entryStepKey: draft.stepOrder[0] ?? "",
    edges,
    terminalStepKeys: draft.stepOrder.filter((key) => !outgoing.has(key))
  };
}

export function draftToReactFlow(draft: WorkflowDraftModel): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const issueByStep = new Map<string, typeof draft.validation.issues>();
  const issueByEdge = new Map<string, typeof draft.validation.issues>();
  for (const issue of draft.validation.issues) {
    if (issue.edgeId) issueByEdge.set(issue.edgeId, [...(issueByEdge.get(issue.edgeId) ?? []), issue]);
    if (issue.stepKey) issueByStep.set(issue.stepKey, [...(issueByStep.get(issue.stepKey) ?? []), issue]);
  }
  const nodes: WorkflowFlowNode[] = [
    {
      id: TRIGGER_NODE_ID,
      type: "workflow",
      position: draft.ui.nodes?.[TRIGGER_NODE_ID] ?? { x: 0, y: 0 },
      data: { label: draft.trigger.name, stepKey: TRIGGER_NODE_ID, type: "webhook_trigger", summary: "Webhook entry", issues: [], readOnly: true }
    },
    ...draft.stepOrder.map((key) => {
      const step = draft.stepsByKey[key];
      return {
        id: key,
        type: "workflow",
        position: draft.ui.nodes?.[key] ?? { x: 260, y: 0 },
        data: {
          label: step.name,
          stepKey: key,
          type: step.type,
          summary: stepSummary(step),
          issues: issueByStep.get(key) ?? [],
          readOnly: draft.readOnly,
          cases: Array.isArray(step.config.cases)
            ? (step.config.cases as Array<Record<string, unknown>>).map((entry) => ({ key: String(entry.key ?? ""), label: String(entry.label ?? entry.key ?? "Case") }))
            : undefined
        }
      } satisfies WorkflowFlowNode;
    })
  ];
  const entry = draft.stepOrder[0];
  const edges: WorkflowFlowEdge[] = [
    ...(entry
      ? [
          {
            id: TRIGGER_EDGE_ID,
            source: TRIGGER_NODE_ID,
            sourceHandle: "trigger",
            target: entry,
            animated: true,
            data: { uiOnly: true },
            label: "entry"
          } satisfies WorkflowFlowEdge
        ]
      : []),
    ...draft.edges.map((edge) => ({
      id: edgeId(edge),
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: "in",
      label: edge.sourceHandle === "next" ? undefined : edge.sourceHandle.replace("case:", ""),
      className: issueByEdge.get(graphEdgeIssueId(edge))?.some((issue) => issue.severity === "error") ? "workflow-edge-invalid" : undefined,
      data: { label: edge.sourceHandle, issues: issueByEdge.get(graphEdgeIssueId(edge)) ?? [] }
    }))
  ];
  return { nodes, edges };
}

export function reactFlowChangesToDraft(draft: WorkflowDraftModel, nodeChanges: NodeChange[] = [], edgeChanges: EdgeChange[] = []): WorkflowDraftModel {
  let next = draft;
  for (const change of nodeChanges) {
    if (change.type === "position" && change.position && change.id) {
      next = {
        ...next,
        ui: { ...next.ui, nodes: { ...(next.ui.nodes ?? {}), [change.id]: { ...next.ui.nodes?.[change.id], x: change.position.x, y: change.position.y } } },
        dirty: { ...next.dirty, layout: true }
      };
    }
    if (change.type === "select" && change.id !== TRIGGER_NODE_ID) {
      next = { ...next, selectedStepKey: change.selected ? change.id : next.selectedStepKey };
    }
  }
  for (const change of edgeChanges) {
    if (change.type === "remove" && change.id !== TRIGGER_EDGE_ID) {
      next = { ...next, edges: next.edges.filter((edge) => edgeId(edge) !== change.id), dirty: { ...next.dirty, semantic: true } };
    }
  }
  return withValidation(next);
}

export function addStepToDraft(draft: WorkflowDraftModel, type: StepType): WorkflowDraftModel {
  const key = generateStepKey(type, draft.stepOrder);
  const step = { ...emptyStep(draft.stepOrder.length, type), id: crypto.randomUUID(), key, name: labelForType(type), config: defaultConfig(type), timeoutSeconds: defaultTimeout(type) };
  const previous = draft.stepOrder.at(-1);
  const previousType = previous ? draft.stepsByKey[previous]?.type : undefined;
  const nextEdges = previous && !["if", "switch", "for_each", "try_catch"].includes(previousType ?? "") ? [...draft.edges, { source: previous, sourceHandle: "next", target: key }] : draft.edges;
  return withValidation({
    ...draft,
    stepsByKey: { ...draft.stepsByKey, [key]: step },
    stepOrder: [...draft.stepOrder, key],
    edges: nextEdges,
    selectedStepKey: key,
    dirty: { ...draft.dirty, semantic: true }
  });
}

export function removeStepFromDraft(draft: WorkflowDraftModel, key: string): WorkflowDraftModel {
  const { [key]: _removed, ...stepsByKey } = draft.stepsByKey;
  const { [key]: _uiRemoved, ...uiNodes } = draft.ui.nodes ?? {};
  return withValidation({
    ...draft,
    stepsByKey,
    stepOrder: draft.stepOrder.filter((stepKey) => stepKey !== key),
    edges: draft.edges.filter((edge) => edge.source !== key && edge.target !== key),
    ui: { ...draft.ui, nodes: uiNodes },
    selectedStepKey: draft.selectedStepKey === key ? undefined : draft.selectedStepKey,
    dirty: { ...draft.dirty, semantic: true, layout: true }
  });
}

export function duplicateStepInDraft(draft: WorkflowDraftModel, key: string): WorkflowDraftModel {
  const step = draft.stepsByKey[key];
  if (!step) return draft;
  const nextKey = generateStepKey(step.type, draft.stepOrder);
  const sourcePosition = draft.ui.nodes?.[key] ?? { x: 260, y: 0 };
  const copy = { ...step, id: crypto.randomUUID(), key: nextKey, name: `${step.name} copy`, config: sanitizeCopiedConfig(step.config), expanded: true };
  const index = draft.stepOrder.indexOf(key);
  const stepOrder = [...draft.stepOrder];
  stepOrder.splice(index + 1, 0, nextKey);
  return withValidation({
    ...draft,
    stepsByKey: { ...draft.stepsByKey, [nextKey]: copy },
    stepOrder,
    ui: { ...draft.ui, nodes: { ...(draft.ui.nodes ?? {}), [nextKey]: { x: sourcePosition.x + 40, y: sourcePosition.y + 40 } } },
    selectedStepKey: nextKey,
    dirty: { ...draft.dirty, semantic: true, layout: true }
  });
}

export function connectDraftEdge(draft: WorkflowDraftModel, connection: Connection): { draft: WorkflowDraftModel; error?: string } {
  const source = connection.source ?? "";
  const target = connection.target ?? "";
  const sourceHandle = connection.sourceHandle ?? "next";
  if (!source || !target || source === TRIGGER_NODE_ID || target === TRIGGER_NODE_ID || source === target) {
    return { draft, error: "Invalid connection." };
  }
  if (!draft.stepsByKey[source] || !draft.stepsByKey[target]) return { draft, error: "Connection references a missing step." };
  const semanticError = validateHandleForSource(draft.stepsByKey[source].type, sourceHandle);
  if (semanticError) return { draft, error: semanticError };
  if (draft.edges.some((edge) => edge.source === source && edge.sourceHandle === sourceHandle)) return { draft, error: "This output already has a target." };
  const edge = { source, sourceHandle, target };
  if (wouldCreateCycle(draft, edge)) return { draft, error: "This connection would create a cycle." };
  return { draft: withValidation({ ...draft, edges: [...draft.edges, edge], dirty: { ...draft.dirty, semantic: true } }) };
}

export function withValidation(draft: WorkflowDraftModel): WorkflowDraftModel {
  return { ...draft, validation: validateDraft(draft) };
}

function graphEdgeToDraftEdge(edge: WorkflowGraphDto["edges"][number]): DraftEdge {
  return { source: edge.from, sourceHandle: graphKindToHandle(edge), target: edge.to };
}

function linearEdges(stepOrder: string[]): DraftEdge[] {
  return stepOrder.slice(0, -1).map((source, index) => ({ source, sourceHandle: "next", target: stepOrder[index + 1] }));
}

function formToDraftEdges(steps: StepFormValue[]): DraftEdge[] {
  const keys = new Set(steps.map((step) => step.key));
  const edges: DraftEdge[] = [];
  steps.forEach((step, index) => {
    const nextLinear = steps[index + 1]?.key;
    if (step.type === "if") {
      addFormEdge(edges, keys, step.key, "true", String(step.config.trueStepKey ?? ""));
      addFormEdge(edges, keys, step.key, "false", String(step.config.falseStepKey ?? ""));
      return;
    }
    if (step.type === "switch") {
      const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
      for (const entry of cases) addFormEdge(edges, keys, step.key, `case:${String(entry.key ?? "")}`, String(entry.stepKey ?? ""));
      addFormEdge(edges, keys, step.key, "default", String(step.config.defaultStepKey ?? ""));
      return;
    }
    if (step.type === "for_each") {
      addFormEdge(edges, keys, step.key, "body", String(step.config.bodyStepKey ?? ""));
      addFormEdge(edges, keys, step.key, "done", String(step.config.doneStepKey ?? ""));
      return;
    }
    if (step.type === "try_catch") {
      addFormEdge(edges, keys, step.key, "body", String(step.config.bodyStepKey ?? ""));
      addFormEdge(edges, keys, step.key, "catch", String(step.config.catchStepKey ?? ""));
      addFormEdge(edges, keys, step.key, "finally", String(step.config.finallyStepKey ?? ""));
      addFormEdge(edges, keys, step.key, "done", String(step.config.doneStepKey ?? ""));
      return;
    }
    addFormEdge(edges, keys, step.key, "next", String(step.config.nextStepKey ?? nextLinear ?? ""));
  });
  return edges;
}

function addFormEdge(edges: DraftEdge[], keys: Set<string>, source: string, sourceHandle: string, target: string) {
  if (keys.has(source) && keys.has(target) && source !== target) edges.push({ source, sourceHandle, target });
}

function routeStepFromEdges(step: StepFormValue | undefined, edges: DraftEdge[]) {
  if (!step) return undefined;
  const outgoing = edges.filter((edge) => edge.source === step.key);
  const config = { ...step.config };
  if (step.type === "if") {
    config.trueStepKey = outgoing.find((edge) => edge.sourceHandle === "true")?.target ?? "";
    config.falseStepKey = outgoing.find((edge) => edge.sourceHandle === "false")?.target ?? "";
  } else if (step.type === "switch") {
    const cases = Array.isArray(config.cases) ? (config.cases as Array<Record<string, unknown>>) : [];
    config.cases = cases.map((entry) => {
      const caseKey = String(entry.key ?? "");
      return { ...entry, stepKey: outgoing.find((edge) => edge.sourceHandle === `case:${caseKey}`)?.target ?? "" };
    });
    config.defaultStepKey = outgoing.find((edge) => edge.sourceHandle === "default")?.target ?? "";
  } else if (step.type === "for_each") {
    config.bodyStepKey = outgoing.find((edge) => edge.sourceHandle === "body")?.target ?? "";
    config.doneStepKey = outgoing.find((edge) => edge.sourceHandle === "done")?.target ?? "";
  } else if (step.type === "try_catch") {
    config.bodyStepKey = outgoing.find((edge) => edge.sourceHandle === "body")?.target ?? "";
    config.catchStepKey = outgoing.find((edge) => edge.sourceHandle === "catch")?.target ?? "";
    config.finallyStepKey = outgoing.find((edge) => edge.sourceHandle === "finally")?.target ?? "";
    config.doneStepKey = outgoing.find((edge) => edge.sourceHandle === "done")?.target ?? "";
  } else {
    config.nextStepKey = outgoing.find((edge) => edge.sourceHandle === "next")?.target ?? "";
  }
  return { ...step, config };
}

function switchCaseMetadata(step: StepFormValue | undefined, handle: string) {
  const caseKey = caseKeyFromHandle(handle) ?? "";
  const cases = Array.isArray(step?.config.cases) ? (step?.config.cases as Array<Record<string, unknown>>) : [];
  const entry = cases.find((item) => String(item.key ?? "") === caseKey);
  return { caseKey, label: String(entry?.label ?? entry?.key ?? caseKey) };
}

function graphEdgeIssueId(edge: DraftEdge) {
  const kind = handleToGraphKind(edge.sourceHandle);
  const caseKey = kind === "switch_case" ? caseKeyFromHandle(edge.sourceHandle) ?? "" : "";
  return `${edge.source}:${kind}:${caseKey}->${edge.target}`;
}

function sanitizeCopiedConfig(config: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const lower = key.toLowerCase();
    if (lower.includes("secret") || lower.includes("password") || lower.includes("token") || lower === "authorization") continue;
    result[key] = value;
  }
  return result;
}

function validateHandleForSource(type: StepType, handle: string) {
  if (type === "if") return handle === "true" || handle === "false" ? undefined : "If nodes must connect from True or False.";
  if (type === "switch") return handle === "default" || handle.startsWith("case:") ? undefined : "Switch nodes must connect from a case or Default.";
  if (type === "for_each") return handle === "body" || handle === "done" ? undefined : "FOR_EACH nodes must connect from Body or Done.";
  if (type === "try_catch") return ["body", "catch", "finally", "done"].includes(handle) ? undefined : "TRY_CATCH nodes must connect from Body, Catch, Finally or Done.";
  return handle === "next" ? undefined : "This node type can only use a Next connection.";
}

function stepSummary(step: StepFormValue) {
  if (step.type === "http_request") return `${String(step.config.method ?? "GET")} ${String(step.config.url ?? "URL missing")}`;
  if (step.type.startsWith("ai_")) return "Uses prompt and expressions";
  if (step.type === "email_notification") return `Email to ${String(step.config.to || "recipient missing")}`;
  if (step.type === "database_record") return `Record in ${String(step.config.collection || "collection missing")}`;
  if (step.type.startsWith("data_store_")) return `${step.type.replace("data_store_", "").replace("_record", "").replace("_records", "")} ${String(step.config.key || step.config.keyPrefix || "records")}`;
  if (step.type === "transform") return `Transform ${String(step.config.mode ?? "OBJECT")}`;
  if (step.type === "if") return "Routes true / false";
  if (step.type === "switch") return `${Array.isArray(step.config.cases) ? step.config.cases.length : 0} cases + default`;
  if (step.type === "delay") return `Durable wait: ${String(step.config.duration ?? "")}`;
  if (step.type === "wait_until") return "Durable wait until timestamp";
  if (step.type === "conditional") return "Legacy conditional";
  return step.type;
}

function labelForType(type: StepType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
