import dagre from "@dagrejs/dagre";
import type { WorkflowDefinitionUiDto } from "./types";
import type { WorkflowDraftModel } from "./draft-model";
import { TRIGGER_NODE_ID } from "./draft-model";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 110;

export function autoLayoutDraft(draft: WorkflowDraftModel): WorkflowDefinitionUiDto {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 90 });
  graph.setDefaultEdgeLabel(() => ({}));

  graph.setNode(TRIGGER_NODE_ID, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const key of draft.stepOrder) {
    graph.setNode(key, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const entry = draft.stepOrder[0];
  if (entry) graph.setEdge(TRIGGER_NODE_ID, entry);
  for (const edge of draft.edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const nodes: NonNullable<WorkflowDefinitionUiDto["nodes"]> = {};
  for (const nodeId of [TRIGGER_NODE_ID, ...draft.stepOrder]) {
    const node = graph.node(nodeId);
    if (!node) continue;
    nodes[nodeId] = {
      x: Math.round(node.x - NODE_WIDTH / 2),
      y: Math.round(node.y - NODE_HEIGHT / 2),
      collapsed: draft.ui.nodes?.[nodeId]?.collapsed
    };
  }

  return {
    ...draft.ui,
    nodes,
    viewport: draft.ui.viewport ?? { x: 0, y: 0, zoom: 1 }
  };
}

export function ensureDraftLayout(draft: WorkflowDraftModel) {
  const required = [TRIGGER_NODE_ID, ...draft.stepOrder];
  const hasAllPositions = required.every((key) => Number.isFinite(draft.ui.nodes?.[key]?.x) && Number.isFinite(draft.ui.nodes?.[key]?.y));
  return hasAllPositions ? draft : { ...draft, ui: autoLayoutDraft(draft) };
}
