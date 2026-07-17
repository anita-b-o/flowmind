"use client";

import { useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { JsonViewer } from "../../../components/json-viewer";
import { draftToReactFlow, draftToWorkflowDefinitionDto } from "../draft-adapters";
import { TRIGGER_NODE_ID, type WorkflowDraftModel } from "../draft-model";
import {
  useCancelWorkflowTestRun,
  useCompareTestRunWithLastReal,
  useCreateWorkflowTestRun,
  useRerunWorkflowTestRun,
  useSkipTestWait,
  useWorkflowTestRun,
  useWorkflowTestRuns
} from "../hooks";
import type { TestExternalMode, WorkflowDetail, WorkflowTestRunDetail } from "../types";
import { WorkflowNode } from "../components/visual/workflow-node";
import { useAuth } from "../../auth/use-auth";
import { canRunRealWorkflowTest } from "../../auth/rbac";

const NODE_TYPES = { workflow: WorkflowNode };

export function WorkflowDebugger({ workflow, draft, workflowVersionId, source = "version" }: { workflow: WorkflowDetail; draft: WorkflowDraftModel; workflowVersionId?: string; source?: "version" | "draft" }) {
  const [payloadText, setPayloadText] = useState(JSON.stringify({ trigger: { body: { email: "ada@example.com", priority: "high" }, headers: {} } }, null, 2));
  const [externalMode, setExternalMode] = useState<TestExternalMode>("mock");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(draft.stepOrder[0] ?? null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [realConfirmOpen, setRealConfirmOpen] = useState(false);
  const [realConfirmed, setRealConfirmed] = useState(false);
  const auth = useAuth();
  const activeRole = auth.organizations.find((organization) => organization.id === auth.activeOrganizationId)?.role;
  const canRunReal = canRunRealWorkflowTest(activeRole);
  const runs = useWorkflowTestRuns(workflow.id);
  const createRun = useCreateWorkflowTestRun(workflow.id);
  const selectedRun = useWorkflowTestRun(workflow.id, selectedRunId);
  const detail = selectedRun.data;
  const cancelRun = useCancelWorkflowTestRun(workflow.id);
  const rerun = useRerunWorkflowTestRun(workflow.id);
  const skipWait = useSkipTestWait(workflow.id, selectedRunId);
  const comparison = useCompareTestRunWithLastReal(workflow.id, selectedRunId);
  const sideEffectNodes = useMemo(() => collectSideEffectNodes(draft), [draft]);

  const graph = useMemo(() => {
    const base = draftToReactFlow({ ...draft, readOnly: true });
    const debug = detail?.graph ?? {};
    return {
      nodes: base.nodes.map((node) => ({ ...node, data: { ...node.data, readOnly: true, debugStatus: debug[node.id] } })),
      edges: base.edges.map((edge) => ({ ...edge, animated: Boolean(edge.target && debug[edge.target] === "active") }))
    };
  }, [draft, detail]);

  async function run(options: { realConfirmed?: boolean } = {}) {
    try {
      setPayloadError(null);
      if (externalMode === "real" && !canRunReal) {
        setPayloadError("Real mode requires an admin or owner role.");
        return;
      }
      if (externalMode === "real" && options.realConfirmed !== true) {
        setRealConfirmed(false);
        setRealConfirmOpen(true);
        return;
      }
      const parsed = JSON.parse(payloadText);
      const result = await createRun.mutateAsync({
        workflowVersionId,
        ...(source === "draft" ? { draftDefinition: draftToWorkflowDefinitionDto(draft) } : {}),
        payload: {
          trigger: parsed.trigger ?? parsed,
          metadata: parsed.metadata ?? {}
        },
        externalMode,
        stepMocks: {},
        compareWithLastReal: true,
        realModeConfirmed: externalMode === "real" ? options.realConfirmed === true : undefined
      });
      setSelectedRunId(result.id);
      setSelectedStepKey(draft.stepOrder[0] ?? null);
      setRealConfirmOpen(false);
      setRealConfirmed(false);
    } catch (error: any) {
      setPayloadError(error?.message ?? "Invalid test payload");
    }
  }

  const inspector = selectedStepKey ? detail?.inspector?.[selectedStepKey] : undefined;
  const currentComparison = comparison.data ?? detail?.comparison;
  const isActive = detail && ["QUEUED", "RUNNING", "RETRYING"].includes(detail.status);

  return (
    <section className="workflow-debugger">
      <div className="debugger-toolbar panel">
        <label>
          Test payload
          <textarea value={payloadText} onChange={(event) => setPayloadText(event.target.value)} rows={7} />
        </label>
        <div className="debugger-controls">
          <span className="status-badge" aria-live="polite">{source === "draft" ? "Testing draft snapshot" : "Testing saved version"}</span>
          <label>
            Mode
            <select value={externalMode} onChange={(event) => setExternalMode(event.target.value as TestExternalMode)}>
              <option value="mock">Mock</option>
              <option value="real">Real</option>
            </select>
          </label>
          <button type="button" onClick={() => void run()} disabled={createRun.isPending || (externalMode === "real" && !canRunReal)}>
            {createRun.isPending ? "Running..." : "Run test"}
          </button>
          <button type="button" disabled={!selectedRunId || !isActive} onClick={() => selectedRunId && cancelRun.mutate(selectedRunId)}>
            Cancel
          </button>
          <button type="button" disabled={!selectedRunId} onClick={() => selectedRunId && rerun.mutate(selectedRunId, { onSuccess: (run) => setSelectedRunId(run.id) })}>
            Rerun
          </button>
        </div>
        {payloadError && <p className="field-error">{payloadError}</p>}
        {externalMode === "real" && (
          <p className="form-warning">
            Real mode may call external HTTP, AI and email providers. Database remains dry-run. {canRunReal ? `${sideEffectNodes.length} side-effect node${sideEffectNodes.length === 1 ? "" : "s"} detected.` : "Admin or owner role required."}
          </p>
        )}
      </div>

      <div className="debugger-grid">
        <ReactFlowProvider>
          <section className="workflow-canvas-panel debugger-canvas">
            <div className="workflow-canvas" role="application" aria-label="Workflow debugger">
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={NODE_TYPES}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                fitView
                onNodeClick={(_, node) => node.id !== TRIGGER_NODE_ID && setSelectedStepKey(node.id)}
              >
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
          </section>
        </ReactFlowProvider>
        <Inspector detail={detail} selectedStepKey={selectedStepKey} onSkipWait={(stepKey) => skipWait.mutate(stepKey)} />
      </div>

      <div className="debugger-grid lower">
        <Timeline detail={detail} />
        <History items={runs.data?.items ?? []} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
      </div>

      {currentComparison && (
        <section className="panel stack">
          <h2>Comparison</h2>
          <p className="muted">{currentComparison.realExecutionId ? `Compared with ${currentComparison.realExecutionId}` : "No real execution available yet."}</p>
          <JsonViewer value={currentComparison} />
        </section>
      )}
      <RealModeDialog
        open={realConfirmOpen}
        nodes={sideEffectNodes}
        confirmed={realConfirmed}
        setConfirmed={setRealConfirmed}
        onCancel={() => {
          setRealConfirmOpen(false);
          setRealConfirmed(false);
        }}
        onConfirm={() => realConfirmed && void run({ realConfirmed: true })}
        pending={createRun.isPending}
      />
    </section>
  );
}

function RealModeDialog({
  open,
  nodes,
  confirmed,
  setConfirmed,
  onCancel,
  onConfirm,
  pending
}: {
  open: boolean;
  nodes: Array<{ key: string; name: string; type: string; realModeAllowed: boolean }>;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Confirm real test run">
        <h2>Confirm real test run</h2>
        <p className="form-warning">This test can perform external HTTP requests, AI calls, or send emails. Database record steps remain dry-run.</p>
        <div className="stack">
          <strong>Nodes with side effects</strong>
          {!nodes.length && <p className="muted">No side-effect nodes detected.</p>}
          {nodes.map((node) => (
            <div key={node.key} className="version-item">
              <strong>{node.name}</strong>
              <span>{node.type}</span>
              <span className="muted">{node.realModeAllowed ? "May run for real" : "Dry-run only"}</span>
            </div>
          ))}
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I understand this real test may contact external services or send email.
        </label>
        <div className="workflow-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={!confirmed || pending} onClick={onConfirm}>
            {pending ? "Starting..." : "Start real test"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Inspector({ detail, selectedStepKey, onSkipWait }: { detail?: WorkflowTestRunDetail; selectedStepKey: string | null; onSkipWait: (stepKey: string) => void }) {
  const step = selectedStepKey ? detail?.inspector?.[selectedStepKey] : undefined;
  return (
    <aside className="panel stack debugger-inspector">
      <div>
        <h2>Inspector</h2>
        <p className="muted">{selectedStepKey ?? "Select a node"}</p>
      </div>
      {!step ? (
        <p className="muted">Run a test and select a node to inspect resolved data.</p>
      ) : (
        <>
          <div className="workflow-badges">
            <span className="status-badge">{step.status}</span>
            <span className="status-badge">{step.stepType}</span>
            {step.connection && <span className="status-badge">{step.connection.name ?? step.connection.type}</span>}
          </div>
          {step.retry.nextRetryAt && (
            <button type="button" onClick={() => onSkipWait(step.stepKey)}>
              Skip wait
            </button>
          )}
          <InspectorBlock title="Input" value={step.input} />
          <InspectorBlock title="Resolved Variables" value={step.resolvedVariables} />
          <InspectorBlock title="Expressions" value={step.expressions} />
          <InspectorBlock title="Resolved Config" value={step.resolvedConfig} />
          <InspectorBlock title="Output" value={step.output} />
          <InspectorBlock title="Retry" value={step.retry} />
          <InspectorBlock title="Error" value={step.error} />
        </>
      )}
    </aside>
  );
}

function InspectorBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <details open={title === "Output" || title === "Resolved Config"}>
      <summary>{title}</summary>
      <JsonViewer value={value} />
    </details>
  );
}

function Timeline({ detail }: { detail?: WorkflowTestRunDetail }) {
  return (
    <section className="panel stack debugger-timeline">
      <h2>Timeline</h2>
      {!detail?.timeline.length ? <p className="muted">No test run selected.</p> : null}
      {detail?.timeline.map((event) => (
        <div key={event.id} className="timeline-row">
          <span className={`timeline-dot ${event.status.toLowerCase()}`} />
          <div>
            <strong>{event.message}</strong>
            <p className="muted">
              {formatDate(event.timestamp)}
              {event.nextRetryAt ? ` · resumes ${countdown(event.nextRetryAt)}` : ""}
              {event.durationMs !== null && event.durationMs !== undefined ? ` · ${event.durationMs}ms` : ""}
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}

function History({ items, selectedRunId, onSelect }: { items: Array<{ id: string; status: string; externalMode: string; createdAt: string; durationMs: number | null }>; selectedRunId: string | null; onSelect: (id: string) => void }) {
  return (
    <section className="panel stack debugger-history">
      <h2>History</h2>
      {!items.length && <p className="muted">No test runs yet.</p>}
      {items.map((item) => (
        <button key={item.id} type="button" className={selectedRunId === item.id ? "version-item active" : "version-item"} onClick={() => onSelect(item.id)}>
          <strong>{item.status}</strong>
          <span>{item.externalMode}</span>
          <span className="muted">{formatDate(item.createdAt)}</span>
          <span className="muted">{item.durationMs === null ? "running" : `${item.durationMs}ms`}</span>
        </button>
      ))}
    </section>
  );
}

function collectSideEffectNodes(draft: WorkflowDraftModel) {
  return draft.stepOrder
    .map((key) => draft.stepsByKey[key])
    .filter((step) => step && isSideEffectStep(step.type))
    .map((step) => ({ key: step.key, name: step.name, type: step.type, realModeAllowed: step.type !== "database_record" }));
}

function isSideEffectStep(type: string) {
  return type === "http_request" || type === "email_notification" || type === "database_record" || type.startsWith("ai_");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function countdown(value: string) {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return "now";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}
