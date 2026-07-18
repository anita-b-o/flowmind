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

  it("accepts a structured FOR_EACH body and keeps arbitrary cycles invalid", () => {
    const steps = [
      { key: "loop", type: "for_each", config: { source: "{{trigger.body.items}}", mode: "SEQUENTIAL", concurrency: 1, maxItems: 100, maxResults: 20 } },
      { key: "body", type: "transform", config: { mode: "OBJECT", fields: { value: "{{item}}" } } },
      { key: "done", type: "database_record", config: {} }
    ];
    expect(() => validateWorkflowGraph(steps, { entryStepKey: "loop", edges: [
      { from: "loop", to: "body", kind: "for_each_body" },
      { from: "loop", to: "done", kind: "for_each_done" },
      { from: "body", to: "done", kind: "next" }
    ] })).not.toThrow();
    expect(() => validateWorkflowGraph(steps, { entryStepKey: "loop", edges: [
      { from: "loop", to: "body", kind: "for_each_body" },
      { from: "loop", to: "done", kind: "for_each_done" },
      { from: "body", to: "loop", kind: "next" }
    ] })).toThrow(BadRequestException);
  });

  it("rejects empty, escaping, and nested FOR_EACH bodies", () => {
    expect(() => validateWorkflowGraph([
      { key: "loop", type: "for_each", config: { source: [] } },
      { key: "done", type: "database_record", config: {} }
    ], { entryStepKey: "loop", edges: [
      { from: "loop", to: "done", kind: "for_each_body" },
      { from: "loop", to: "done", kind: "for_each_done" }
    ] })).toThrow(BadRequestException);

    expect(() => validateWorkflowGraph([
      { key: "outer", type: "for_each", config: { source: [] } },
      { key: "inner", type: "for_each", config: { source: [] } },
      { key: "done", type: "database_record", config: {} }
    ], { entryStepKey: "outer", edges: [
      { from: "outer", to: "inner", kind: "for_each_body" },
      { from: "outer", to: "done", kind: "for_each_done" },
      { from: "inner", to: "done", kind: "for_each_body" },
      { from: "inner", to: "done", kind: "for_each_done" }
    ] })).toThrow(BadRequestException);
  });

  it("accepts structured TRY_CATCH regions with optional Finally", () => {
    const steps = [
      { key: "try", type: "try_catch", config: {} }, { key: "body", type: "http_request", config: {} },
      { key: "catch", type: "set_variable", config: {} }, { key: "finally", type: "database_record", config: {} },
      { key: "done", type: "database_record", config: {} }
    ];
    expect(() => validateWorkflowGraph(steps, { entryStepKey: "try", edges: [
      { from: "try", to: "body", kind: "try_body" }, { from: "try", to: "catch", kind: "try_catch" },
      { from: "try", to: "finally", kind: "try_finally" }, { from: "try", to: "done", kind: "try_done" },
      { from: "body", to: "finally", kind: "next" }, { from: "catch", to: "finally", kind: "next" }, { from: "finally", to: "done", kind: "next" }
    ] })).not.toThrow();
  });

  it("rejects TRY_CATCH without Catch and with an external Body entry", () => {
    const steps = [{ key: "before", type: "transform", config: {} }, { key: "try", type: "try_catch", config: {} }, { key: "body", type: "transform", config: {} }, { key: "done", type: "database_record", config: {} }];
    expect(() => validateWorkflowGraph(steps, { entryStepKey: "before", edges: [
      { from: "before", to: "try", kind: "next" }, { from: "before", to: "body", kind: "next" },
      { from: "try", to: "body", kind: "try_body" }, { from: "try", to: "done", kind: "try_done" }, { from: "body", to: "done", kind: "next" }
    ] })).toThrow(BadRequestException);
  });
});
