import { BadRequestException } from "@nestjs/common";
import { validateWorkflowGraph } from "../src/workflows/workflow-graph-validator";

describe("workflow graph validator", () => {
  it("accepts acyclic if graphs", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { key: "route", type: "if", config: { left: "{{trigger.body.kind}}", operator: "equals", right: "vip", trueStepKey: "vip", falseStepKey: "normal" } },
          { key: "vip", type: "database_record", config: {} },
          { key: "normal", type: "database_record", config: {} }
        ],
        {
          entryStepKey: "route",
          edges: [
            { from: "route", to: "vip", kind: "if_true", label: "true" },
            { from: "route", to: "normal", kind: "if_false", label: "false" },
            { from: "vip", to: "normal", kind: "next" }
          ]
        }
      )
    ).not.toThrow();
  });

  it("rejects cycles and invalid waits", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { key: "a", type: "delay", config: { duration: "0 seconds" } },
          { key: "b", type: "database_record", config: {} }
        ],
        { entryStepKey: "a", edges: [{ from: "a", to: "b", kind: "next" }, { from: "b", to: "a", kind: "next" }] }
      )
    ).toThrow(BadRequestException);
  });

  it("rejects duplicate edges and missing If branches", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { key: "route", type: "if", config: { left: "{{trigger.body.kind}}", operator: "equals", right: "vip", trueStepKey: "vip", falseStepKey: "normal" } },
          { key: "vip", type: "database_record", config: {} },
          { key: "normal", type: "database_record", config: {} }
        ],
        {
          entryStepKey: "route",
          edges: [
            { from: "route", to: "vip", kind: "if_true", label: "true" },
            { from: "route", to: "vip", kind: "if_true", label: "true" }
          ]
        }
      )
    ).toThrow(BadRequestException);
  });

  it("rejects invalid switch cases and orphan case edges", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { key: "route", type: "switch", config: { value: "{{trigger.body.kind}}", cases: [{ key: "urgent", match: "urgent", stepKey: "notify" }, { key: "urgent", match: "urgent", stepKey: "save" }], defaultStepKey: "save" } },
          { key: "notify", type: "email_notification", config: {} },
          { key: "save", type: "database_record", config: {} }
        ],
        {
          entryStepKey: "route",
          edges: [
            { from: "route", to: "notify", kind: "switch_case", caseKey: "missing" },
            { from: "route", to: "save", kind: "switch_default" }
          ]
        }
      )
    ).toThrow(BadRequestException);
  });
});
