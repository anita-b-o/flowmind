"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { WorkflowFlowNode } from "../../draft-model";
import { TRIGGER_NODE_ID } from "../../draft-model";

export function WorkflowNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const hasErrors = data.issues.some((issue) => issue.severity === "error");
  const hasWarnings = data.issues.some((issue) => issue.severity === "warning");
  const isTrigger = id === TRIGGER_NODE_ID;
  const isIf = data.type === "if";
  const isSwitch = data.type === "switch";
  const isTerminalCapable = !isIf && !isSwitch;

  return (
    <div className={`workflow-flow-node ${selected ? "selected" : ""} ${hasErrors ? "invalid" : hasWarnings ? "warning" : ""}`}>
      {!isTrigger && <Handle id="in" type="target" position={Position.Left} isConnectable={!data.readOnly} />}
      <div className="workflow-flow-node-header">
        <span className="workflow-flow-node-kind">{nodeKind(data.type)}</span>
        {(hasErrors || hasWarnings) && <span className="workflow-flow-node-status">{hasErrors ? "Error" : "Warning"}</span>}
      </div>
      <strong>{data.label}</strong>
      <span className="muted">{data.stepKey}</span>
      <p>{data.summary}</p>
      {isTrigger && <Handle id="trigger" type="source" position={Position.Right} isConnectable={false} />}
      {isTerminalCapable && !isTrigger && <OutputHandle id="next" label="Next" disabled={data.readOnly} />}
      {isIf && (
        <>
          <OutputHandle id="true" label="Yes" disabled={data.readOnly} offset={36} />
          <OutputHandle id="false" label="No" disabled={data.readOnly} offset={78} />
        </>
      )}
      {isSwitch && (
        <>
          {(data.cases ?? []).map((entry, index) => (
            <OutputHandle key={entry.key} id={`case:${entry.key}`} label={entry.label || entry.key} disabled={data.readOnly} offset={34 + index * 34} />
          ))}
          <OutputHandle id="default" label="Default" disabled={data.readOnly} offset={34 + (data.cases?.length ?? 0) * 34} />
        </>
      )}
    </div>
  );
}

function OutputHandle({ id, label, disabled, offset }: { id: string; label: string; disabled: boolean; offset?: number }) {
  return (
    <div className="workflow-flow-handle-label" style={offset ? { top: offset } : undefined}>
      <span>{label}</span>
      <Handle id={id} type="source" position={Position.Right} isConnectable={!disabled} />
    </div>
  );
}

function nodeKind(type: string) {
  if (type === "webhook_trigger") return "Trigger";
  if (type.startsWith("ai_")) return "AI";
  if (type === "if" || type === "switch" || type === "conditional") return "Logic";
  if (type === "delay" || type === "wait_until") return "Wait";
  return "Action";
}
