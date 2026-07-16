import { describe, expect, it } from "vitest";
import { draftToGraph, draftToReactFlow, draftToWorkflowDefinitionDto, workflowVersionToDraft } from "./draft-adapters";
import type { WorkflowDetail, WorkflowVersion } from "./types";

describe("workflow draft adapters", () => {
  it("loads graph v2, preserves switch handles and serializes ui metadata", () => {
    const draft = workflowVersionToDraft(workflow(), version());

    expect(draft.edges).toEqual(
      expect.arrayContaining([
        { source: "route", sourceHandle: "true", target: "vip" },
        { source: "route", sourceHandle: "false", target: "switch_priority" },
        { source: "switch_priority", sourceHandle: "case:urgent", target: "notify" },
        { source: "switch_priority", sourceHandle: "default", target: "save" },
        { source: "notify", sourceHandle: "next", target: "save" }
      ])
    );

    const flow = draftToReactFlow(draft);
    expect(flow.nodes.map((node) => node.id)).toContain("webhook");
    expect(flow.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: "webhook", target: "route", data: { uiOnly: true } })]));

    const dto = draftToWorkflowDefinitionDto(draft);
    expect(dto.workflowDefinitionSchemaVersion).toBe(2);
    expect(dto.ui?.nodes?.route).toEqual({ x: 260, y: 40 });
    expect(dto.graph?.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "switch_priority", to: "notify", kind: "switch_case", caseKey: "urgent" })]));
  });

  it("creates a transient linear v2 graph for legacy versions", () => {
    const legacy = version();
    legacy.definitionJson.workflowDefinitionSchemaVersion = 1;
    legacy.definitionJson.graph = undefined;
    const draft = workflowVersionToDraft(workflow(), legacy);

    expect(draft.sourceSchemaVersion).toBe(1);
    expect(draftToGraph(draft).edges).toEqual(
      expect.arrayContaining([
        { from: "route", to: "vip", kind: "next" },
        { from: "vip", to: "switch_priority", kind: "next" }
      ])
    );
  });
});

function workflow(): Pick<WorkflowDetail, "name" | "description"> {
  return { name: "Lead flow", description: "" };
}

function version(): WorkflowVersion {
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
      ui: {
        nodes: {
          webhook: { x: 0, y: 40 },
          route: { x: 260, y: 40 },
          switch_priority: { x: 520, y: 140 },
          vip: { x: 520, y: -80 },
          notify: { x: 780, y: 80 },
          save: { x: 1040, y: 80 }
        }
      },
      steps: []
    },
    steps: [
      { id: "trigger", key: "webhook", name: "Webhook", type: "webhook_trigger", position: 0, configJson: {} },
      {
        id: "route",
        key: "route",
        name: "Route",
        type: "if",
        position: 1,
        configJson: { left: "{{trigger.body.kind}}", operator: "equals", right: "vip", trueStepKey: "vip", falseStepKey: "switch_priority" },
        retryPolicyJson: { retry: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" } },
        timeoutSeconds: 30
      },
      { id: "vip", key: "vip", name: "VIP", type: "database_record", position: 2, configJson: { collection: "leads", data: {} }, timeoutSeconds: 30 },
      {
        id: "switch",
        key: "switch_priority",
        name: "Priority",
        type: "switch",
        position: 3,
        configJson: { value: "{{trigger.body.priority}}", cases: [{ key: "urgent", label: "Urgent", match: "urgent", stepKey: "notify" }], defaultStepKey: "save" },
        timeoutSeconds: 30
      },
      { id: "notify", key: "notify", name: "Notify", type: "email_notification", position: 4, configJson: { connectionId: "smtp-1", to: "ops@example.com", subject: "Lead", text: "Hi" }, timeoutSeconds: 30 },
      { id: "save", key: "save", name: "Save", type: "database_record", position: 5, configJson: { collection: "leads", data: {} }, timeoutSeconds: 30 }
    ]
  };
}
