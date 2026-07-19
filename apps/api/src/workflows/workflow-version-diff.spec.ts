import { diffFields, normalizeDefinition, workflowVersionDiff } from "./workflow-version-diff";

const definition = (steps: any[], edges: any[] = [], extra: Record<string, unknown> = {}) => ({
  trigger: { key: "trigger", name: "Webhook", type: "webhook_trigger", config: {} }, steps,
  workflowDefinitionSchemaVersion: 2, expressionMode: "strict", workflowVariables: {}, environmentVariables: {},
  graph: { entryStepKey: steps[0]?.key ?? "", edges, terminalStepKeys: steps.length ? [steps.at(-1).key] : [] }, ...extra
});
const step = (key: string, type = "transform", config: Record<string, unknown> = {}) => ({ key, name: key, type, config });

describe("workflow version semantic diff", () => {
  it("detects added/removed steps and edges", () => {
    const result = workflowVersionDiff(definition([step("A"), step("B")], [{ from: "A", to: "B", kind: "next" }]), definition([step("A"), step("C")], [{ from: "A", to: "C", kind: "next" }]));
    expect(result.groups.STEPS_REMOVED).toEqual([{ key: "B", name: "B", type: "transform" }]);
    expect(result.groups.STEPS_ADDED).toEqual([{ key: "C", name: "C", type: "transform" }]);
    expect(result.groups.EDGES_REMOVED).toHaveLength(1);
    expect(result.summary.maxSeverity).toBe("BREAKING");
  });

  it("reports recursive field paths and redacts secrets", () => {
    const changes = diffFields({ config: { nested: { timeout: 1 }, headers: { Authorization: "Bearer old" }, token: "old" } }, { config: { nested: { timeout: 2 }, headers: { Authorization: "Bearer new" }, token: "new" } });
    expect(changes).toContainEqual({ fieldPath: "config.nested.timeout", changeType: "MODIFIED", before: 1, after: 2 });
    expect(changes).toContainEqual({ fieldPath: "config.headers.Authorization", changeType: "MODIFIED", sensitive: true, changed: true });
    expect(changes).toContainEqual({ fieldPath: "config.token", changeType: "MODIFIED", sensitive: true, changed: true });
    expect(JSON.stringify(changes)).not.toContain("Bearer old");
  });

  it("marks removal of a referenced producer as breaking", () => {
    const result = workflowVersionDiff(definition([step("A"), step("B", "transform", { value: "{{steps.A.output.value}}" })]), definition([step("B", "transform", { value: "{{steps.A.output.value}}" })]));
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REFERENCED_STEP_REMOVED", severity: "BREAKING", stepKey: "A" })]));
  });

  it("ignores UI and incidental step ids while preserving variables", () => {
    const left = definition([{ id: "one", ...step("A") }], [], { ui: { nodes: { A: { x: 1, y: 2 } } }, workflowVariables: { customer: 1 } });
    const right = definition([{ id: "two", ...step("A") }], [], { ui: { nodes: { A: { x: 8, y: 9 } } }, workflowVariables: { customer: 1 } });
    expect(normalizeDefinition(left)).toEqual(normalizeDefinition(right));
    expect(workflowVersionDiff(left, right).summary.totalChanges).toBe(0);
  });

  it("preserves pinned subworkflow selectors and flags changes", () => {
    const left = definition([step("call", "execute_workflow", { workflowId: "B", versionPolicy: "PINNED_VERSION", workflowVersionId: "B-v1" })]);
    const restored = JSON.parse(JSON.stringify(left));
    expect(normalizeDefinition(restored)).toEqual(normalizeDefinition(left));
    const right = definition([step("call", "execute_workflow", { workflowId: "B", versionPolicy: "PINNED_VERSION", workflowVersionId: "B-v2" })]);
    expect(workflowVersionDiff(left, right).summary.maxSeverity).toBe("BREAKING");
  });
});
