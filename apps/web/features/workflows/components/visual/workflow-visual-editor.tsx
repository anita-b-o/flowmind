"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type EdgeChange,
  type Node,
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
  canRedo,
  canUndo,
  onRedo,
  register,
  errors,
  setValue,
  getValues,
  onUndo,
  saveState,
  saving
}: {
  draft: WorkflowDraftModel;
  applyDraft: (draft: WorkflowDraftModel, options?: { syncForm?: boolean; record?: boolean }) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  saveState: string;
  saving: boolean;
}) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const dragStartRef = useRef<WorkflowDraftModel | null>(null);
  const { nodes, edges } = useMemo(() => draftToReactFlow(draft), [draft]);
  const hasPositions = Boolean(draft.ui.nodes && Object.keys(draft.ui.nodes).length);

  function onNodesChange(changes: NodeChange[]) {
    applyDraft(reactFlowChangesToDraft(draft, changes, []), { syncForm: false, record: !changes.some((change) => change.type === "position") });
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
    const step = draft.stepsByKey[key];
    const hasConfig = step && Object.values(step.config).some((value) => value !== "" && value !== "{}" && value !== undefined && value !== null);
    if ((hasEdges || hasConfig) && !window.confirm("Delete this node? Its configuration and connected edges will be removed. Undo can restore it.")) return;
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
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.key === "Delete" || event.key === "Backspace") && draft.selectedStepKey && !draft.readOnly) {
        event.preventDefault();
        removeNode(draft.selectedStepKey);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
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
              <span className="status-badge" aria-live="polite">{saveState}</span>
              <button type="button" onClick={onUndo} disabled={draft.readOnly || !canUndo || saving} aria-label="Undo">
                Undo
              </button>
              <button type="button" onClick={onRedo} disabled={draft.readOnly || !canRedo || saving} aria-label="Redo">
                Redo
              </button>
              <button type="button" onClick={arrange} disabled={draft.readOnly || saving}>
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
              onNodeDragStart={() => {
                dragStartRef.current = draft;
              }}
              onNodeDragStop={(_, node: Node) => {
                if (!dragStartRef.current || draft.readOnly) return;
                const next = withValidation({
                  ...draft,
                  ui: { ...draft.ui, nodes: { ...(draft.ui.nodes ?? {}), [node.id]: { ...draft.ui.nodes?.[node.id], x: node.position.x, y: node.position.y } } },
                  dirty: { ...draft.dirty, layout: true }
                });
                dragStartRef.current = null;
                applyDraft(next, { syncForm: false, record: true });
              }}
              onNodeClick={(_, node) => node.id !== TRIGGER_NODE_ID && applyDraft({ ...draft, selectedStepKey: node.id }, { syncForm: false })}
              nodesDraggable={!draft.readOnly && !saving}
              nodesConnectable={!draft.readOnly && !saving}
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
