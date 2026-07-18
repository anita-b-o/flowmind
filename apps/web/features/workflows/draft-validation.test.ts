import { describe, expect, it } from "vitest";
import { addStepToDraft, connectDraftEdge, duplicateStepInDraft, removeStepFromDraft, withValidation } from "./draft-adapters";
import { createDraftHistory, pushDraftHistory, redoDraftHistory, undoDraftHistory } from "./draft-history";
import { workflowVersionToDraft } from "./draft-adapters";
import type { WorkflowDetail, WorkflowVersion } from "./types";

describe("visual draft validation and history", () => {
  it("creates nodes, connects valid edges, and rejects self-loops and cycles", () => {
    let draft = workflowVersionToDraft(workflow(), undefined);
    draft = addStepToDraft(draft, "database_record");
    draft = addStepToDraft(draft, "email_notification");

    expect(draft.stepOrder).toHaveLength(2);
    expect(draft.validation.issues.some((issue) => issue.code === "unreachable")).toBe(false);

    const self = connectDraftEdge(draft, { source: draft.stepOrder[0], target: draft.stepOrder[0], sourceHandle: "next", targetHandle: "in" });
    expect(self.error).toMatch(/invalid/i);

    const cycle = connectDraftEdge(draft, { source: draft.stepOrder[1], target: draft.stepOrder[0], sourceHandle: "next", targetHandle: "in" });
    expect(cycle.error).toMatch(/cycle/i);
  });

  it("detects disconnected nodes, duplicate ids, duplicate keys, and required config", () => {
    const draft = withValidation({
      ...workflowVersionToDraft(workflow(), undefined),
      stepOrder: ["save", "save"],
      stepsByKey: {
        save: {
          id: "same",
          key: "save",
          name: "Save",
          type: "database_record",
          expanded: true,
          config: { collection: "", data: "" },
          retryPolicy: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" },
          timeoutSeconds: 30
        }
      },
      edges: []
    });

    expect(codes(draft)).toEqual(expect.arrayContaining(["duplicate_step_key", "required_config"]));
  });

  it("validates If and Switch branch semantics", () => {
    const draft = workflowVersionToDraft(workflow(), graphVersion());
    expect(draft.validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);

    const broken = withValidation({
      ...draft,
      edges: draft.edges.filter((edge) => edge.sourceHandle !== "false"),
      stepsByKey: {
        ...draft.stepsByKey,
        switch_priority: {
          ...draft.stepsByKey.switch_priority,
          config: { ...draft.stepsByKey.switch_priority.config, cases: [{ key: "urgent", label: "Urgent", match: "urgent", stepKey: "notify" }, { key: "urgent", label: "Urgent 2", match: "urgent", stepKey: "save" }] }
        }
      }
    });

    expect(codes(broken)).toEqual(expect.arrayContaining(["missing_if_false_edge", "invalid_switch_case_key", "duplicate_switch_case_match"]));
  });

  it("validates expressions against graph predecessors", () => {
    const draft = withValidation({
      ...workflowVersionToDraft(workflow(), graphVersion()),
      stepsByKey: {
        ...workflowVersionToDraft(workflow(), graphVersion()).stepsByKey,
        route: {
          ...workflowVersionToDraft(workflow(), graphVersion()).stepsByKey.route,
          config: { left: "{{steps.save.output.id}}", operator: "equals", right: "x", trueStepKey: "vip", falseStepKey: "switch_priority" }
        }
      }
    });

    expect(codes(draft)).toContain("invalid_expression");
  });

  it("validates variable node scope, names and unsafe values", () => {
    const base = workflowVersionToDraft(workflow(), undefined);
    const draft = withValidation({
      ...base,
      stepOrder: ["set_bad"],
      stepsByKey: {
        set_bad: {
          id: "set_bad",
          key: "set_bad",
          name: "Set bad",
          type: "set_variable",
          expanded: true,
          config: { scope: "execution", name: "__proto__", valueKind: "literal", valueType: "json", value: "{\"ok\":true}" },
          retryPolicy: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" },
          timeoutSeconds: 30
        }
      },
      edges: []
    });

    expect(codes(draft)).toContain("invalid_variable_name");
  });

  it("duplicates without edges and restores deletion with undo", () => {
    const draft = workflowVersionToDraft(workflow(), graphVersion());
    const duplicated = duplicateStepInDraft(draft, "save");

    expect(duplicated.selectedStepKey).toBe("database_record_1");
    expect(duplicated.edges.some((edge) => edge.source === "database_record_1" || edge.target === "database_record_1")).toBe(false);

    let history = createDraftHistory(duplicated);
    const removed = removeStepFromDraft(duplicated, "database_record_1");
    history = pushDraftHistory(history, removed);
    history = undoDraftHistory(history);
    expect(history.present.stepsByKey.database_record_1).toBeDefined();
    history = redoDraftHistory(history);
    expect(history.present.stepsByKey.database_record_1).toBeUndefined();
  });
});

function codes(draft: { validation: { issues: Array<{ code: string }> } }) {
  return draft.validation.issues.map((issue) => issue.code);
}

function workflow(): Pick<WorkflowDetail, "name" | "description"> {
  return { name: "Lead flow", description: "" };
}

function graphVersion(): WorkflowVersion {
  return {
    id: "version-1",
    versionNumber: 1,
    status: "DRAFT",
    createdAt: "2026-01-01T00:00:00.000Z",
    activatedAt: null,
    definitionJson: {
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      workflowDefinitionSchemaVersion: 2,
      graph: {
        entryStepKey: "route",
        edges: [
          { from: "route", to: "vip", kind: "if_true", label: "true" },
          { from: "route", to: "switch_priority", kind: "if_false", label: "false" },
          { from: "switch_priority", to: "notify", kind: "switch_case", label: "Urgent", caseKey: "urgent" },
          { from: "switch_priority", to: "save", kind: "switch_default", label: "default" },
          { from: "notify", to: "save", kind: "next" }
        ],
        terminalStepKeys: ["save"]
      },
      steps: []
    },
    steps: [
      { id: "trigger", key: "webhook", name: "Webhook", type: "webhook_trigger", position: 0, configJson: {} },
      { id: "route", key: "route", name: "Route", type: "if", position: 1, configJson: { left: "{{trigger.body.kind}}", operator: "equals", right: "vip", trueStepKey: "vip", falseStepKey: "switch_priority" }, timeoutSeconds: 30 },
      { id: "vip", key: "vip", name: "VIP", type: "database_record", position: 2, configJson: { collection: "leads", data: {} }, timeoutSeconds: 30 },
      { id: "switch", key: "switch_priority", name: "Priority", type: "switch", position: 3, configJson: { value: "{{trigger.body.priority}}", cases: [{ key: "urgent", label: "Urgent", match: "urgent", stepKey: "notify" }], defaultStepKey: "save" }, timeoutSeconds: 30 },
      { id: "notify", key: "notify", name: "Notify", type: "email_notification", position: 4, configJson: { connectionId: "smtp-1", to: "ops@example.com", subject: "Lead", text: "Hi" }, timeoutSeconds: 30 },
      { id: "save", key: "save", name: "Save", type: "database_record", position: 5, configJson: { collection: "leads", data: {} }, timeoutSeconds: 30 }
    ]
  };
}
