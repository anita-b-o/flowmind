"use client";

import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnEdgesDelete,
  type OnNodesDelete
} from "@xyflow/react";
import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { addStepToDraft, connectDraftEdge, draftToReactFlow, duplicateStepInDraft, reactFlowChangesToDraft, removeStepFromDraft, withValidation } from "../../draft-adapters";
import type { WorkflowDraftModel } from "../../draft-model";
import { TRIGGER_EDGE_ID, TRIGGER_NODE_ID } from "../../draft-model";
import { autoLayoutDraft } from "../../auto-layout";
import type { StepType } from "../../types";
import type { WorkflowEditorFormValue } from "../../workflow-builder";
import { WorkflowConfigPanel } from "./workflow-config-panel";
import { WorkflowNode } from "./workflow-node";
import { WorkflowPalette } from "./workflow-palette";

const NODE_TYPES = { workflow: WorkflowNode };

export function WorkflowVisualEditor({
  draft,
  applyDraft,
  register,
  errors,
  setValue,
  getValues
}: {
  draft: WorkflowDraftModel;
  applyDraft: (draft: WorkflowDraftModel, options?: { syncForm?: boolean }) => void;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
}) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => draftToReactFlow(draft), [draft]);
  const hasPositions = Boolean(draft.ui.nodes && Object.keys(draft.ui.nodes).length);

  function onNodesChange(changes: NodeChange[]) {
    applyDraft(reactFlowChangesToDraft(draft, changes, []), { syncForm: false });
  }

  function onEdgesChange(changes: EdgeChange[]) {
    applyDraft(reactFlowChangesToDraft(draft, [], changes));
  }

  function onConnect(connection: Connection) {
    const result = connectDraftEdge(draft, connection);
    setConnectionError(result.error ?? null);
    applyDraft(result.draft);
  }

  const onNodesDelete: OnNodesDelete = (deleted) => {
    for (const node of deleted) {
      if (node.id === TRIGGER_NODE_ID || draft.readOnly) continue;
      if (!window.confirm("Delete this node and its connected edges?")) continue;
      applyDraft(removeStepFromDraft(draft, node.id));
    }
  };

  const onEdgesDelete: OnEdgesDelete = (deleted) => {
    if (draft.readOnly) return;
    const ids = new Set(deleted.map((edge) => edge.id).filter((id) => id !== TRIGGER_EDGE_ID));
    applyDraft(withValidation({ ...draft, edges: draft.edges.filter((edge) => !ids.has(`${edge.source}:${edge.sourceHandle}->${edge.target}`)), dirty: { ...draft.dirty, semantic: true } }));
  };

  function addNode(type: StepType) {
    applyDraft(addStepToDraft(draft, type));
  }

  function removeNode(key: string) {
    const hasEdges = draft.edges.some((edge) => edge.source === key || edge.target === key);
    if (hasEdges && !window.confirm("Delete this node and its connected edges?")) return;
    applyDraft(removeStepFromDraft(draft, key));
  }

  function duplicateNode(key: string) {
    applyDraft(duplicateStepInDraft(draft, key));
  }

  function arrange() {
    if (hasPositions && !window.confirm("Auto arrange will overwrite current node positions.")) return;
    applyDraft({ ...draft, ui: autoLayoutDraft(draft), dirty: { ...draft.dirty, layout: true } }, { syncForm: false });
  }

  const globalIssues = draft.validation.issues.filter((issue) => !issue.stepKey);
  return (
    <ReactFlowProvider>
      <div className="workflow-visual-shell">
        <WorkflowPalette disabled={draft.readOnly} onAdd={addNode} />
        <section className="workflow-canvas-panel">
          <div className="workflow-visual-toolbar">
            <div>
              <strong>{draft.validation.issues.some((issue) => issue.severity === "error") ? "Graph has errors" : "Graph ready"}</strong>
              <p className="muted">Visual layout does not change execution order.</p>
            </div>
            <div className="workflow-actions">
              <button type="button" onClick={arrange}>
                Auto arrange
              </button>
            </div>
          </div>
          {connectionError && <p className="field-error">{connectionError}</p>}
          {!!globalIssues.length && (
            <div className="workflow-validation-panel" aria-live="polite">
              {globalIssues.map((issue) => (
                <p key={issue.code} className="field-error">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
          <div className="workflow-canvas" role="application" aria-label="Workflow visual editor">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodesDelete={onNodesDelete}
              onEdgesDelete={onEdgesDelete}
              onNodeClick={(_, node) => node.id !== TRIGGER_NODE_ID && applyDraft({ ...draft, selectedStepKey: node.id }, { syncForm: false })}
              nodesDraggable={!draft.readOnly}
              nodesConnectable={!draft.readOnly}
              elementsSelectable
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </section>
        <WorkflowConfigPanel draft={draft} register={register} errors={errors} setValue={setValue} getValues={getValues} onRemove={removeNode} onDuplicate={duplicateNode} />
      </div>
    </ReactFlowProvider>
  );
}
