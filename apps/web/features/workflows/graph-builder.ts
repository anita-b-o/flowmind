import type { WorkflowGraphDto } from "./types";
import type { StepFormValue } from "./workflow-builder";

export function buildGraph(steps: StepFormValue[]): WorkflowGraphDto | undefined {
  if (!steps.length) return undefined;
  const edges: WorkflowGraphDto["edges"] = [];
  const stepKeys = new Set(steps.map((step) => step.key.trim()).filter(Boolean));
  const nextLinearKey = (index: number) => steps[index + 1]?.key.trim();
  steps.forEach((step, index) => {
    const key = step.key.trim();
    if (!key) return;
    if (step.type === "if") {
      addEdge(edges, key, String(step.config.trueStepKey ?? ""), "if_true", "true", undefined, stepKeys);
      addEdge(edges, key, String(step.config.falseStepKey ?? ""), "if_false", "false", undefined, stepKeys);
      return;
    }
    if (step.type === "switch") {
      const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
      cases.forEach((entry) => addEdge(edges, key, String(entry.stepKey ?? ""), "switch_case", String(entry.label ?? entry.key ?? ""), String(entry.key ?? ""), stepKeys));
      addEdge(edges, key, String(step.config.defaultStepKey ?? ""), "switch_default", "default", undefined, stepKeys);
      return;
    }
    if (step.type === "for_each") {
      addEdge(edges, key, String(step.config.bodyStepKey ?? ""), "for_each_body", "body", undefined, stepKeys);
      addEdge(edges, key, String(step.config.doneStepKey ?? ""), "for_each_done", "done", undefined, stepKeys);
      return;
    }
    if (step.type === "try_catch") {
      addEdge(edges, key, String(step.config.bodyStepKey ?? ""), "try_body", "body", undefined, stepKeys);
      addEdge(edges, key, String(step.config.catchStepKey ?? ""), "try_catch", "catch", undefined, stepKeys);
      addEdge(edges, key, String(step.config.finallyStepKey ?? ""), "try_finally", "finally", undefined, stepKeys);
      addEdge(edges, key, String(step.config.doneStepKey ?? ""), "try_done", "done", undefined, stepKeys);
      return;
    }
    if (step.type === "approval") { addEdge(edges, key, String(step.config.approvedStepKey ?? ""), "approval_approved", "approved", undefined, stepKeys); addEdge(edges, key, String(step.config.rejectedStepKey ?? ""), "approval_rejected", "rejected", undefined, stepKeys); addEdge(edges, key, String(step.config.expiredStepKey ?? ""), "approval_expired", "expired", undefined, stepKeys); return; }
    addEdge(edges, key, String(step.config.nextStepKey ?? nextLinearKey(index) ?? ""), "next", undefined, undefined, stepKeys);
  });
  const targets = new Set(edges.map((edge) => edge.from));
  return {
    entryStepKey: steps[0].key.trim(),
    edges,
    terminalStepKeys: steps.map((step) => step.key.trim()).filter((key) => key && !targets.has(key))
  };
}

function addEdge(
  edges: WorkflowGraphDto["edges"],
  from: string,
  to: string,
  kind: WorkflowGraphDto["edges"][number]["kind"],
  label: string | undefined,
  caseKey: string | undefined,
  stepKeys: Set<string>
) {
  const target = to.trim();
  if (!target || !stepKeys.has(target) || target === from) return;
  edges.push({ from, to: target, kind, ...(label ? { label } : {}), ...(caseKey ? { caseKey } : {}) });
}
