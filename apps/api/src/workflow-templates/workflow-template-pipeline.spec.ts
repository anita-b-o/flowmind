import { BadRequestException } from "@nestjs/common";
import { applyMappings, extractDependencies, normalizePortableDefinition, safeTriggerHints } from "./workflow-template-pipeline";

const graph = { entryStepKey: "loop", edges: [{ from: "loop", to: "try", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" }, { from: "try", to: "store", kind: "try_body" }, { from: "try", to: "catch", kind: "try_catch" }, { from: "try", to: "done", kind: "try_done" }, { from: "store", to: "done", kind: "next" }, { from: "catch", to: "done", kind: "next" }] };

describe("workflow template portability pipeline", () => {
  it("preserves Graph v2 control flow while removing operational step ids", () => {
    const definition = normalizePortableDefinition({ workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { id: "row-trigger", key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ id: "row-loop", key: "loop", name: "Loop", type: "for_each", config: { source: "{{trigger.body.items}}" } }, { key: "try", name: "Try", type: "try_catch", config: {} }, { key: "store", name: "Store", type: "data_store_get_record", config: { dataStoreId: "store-1", key: "x" } }, { key: "catch", name: "Catch", type: "transform", config: { mode: "OBJECT", fields: { ok: false } } }, { key: "done", name: "Done", type: "transform", config: { mode: "OBJECT", fields: { ok: true } } }], graph, workflowVariables: { safe: "value" }, environmentVariables: {} });
    expect(definition.graph).toEqual(graph);
    expect((definition.trigger as any).id).toBeUndefined();
    expect((definition.steps as any[])[0].id).toBeUndefined();
  });

  it("extracts and rewrites connection, Data Store and subworkflow dependencies", () => {
    const definition = normalizePortableDefinition({ trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "http", name: "HTTP", type: "http_request", config: { connectionId: "c1", url: "https://example.test" } }, { key: "store", name: "Store", type: "data_store_get_record", config: { dataStoreName: "State", key: "x" } }, { key: "child", name: "Child", type: "execute_workflow", config: { workflowId: "w1", versionPolicy: "PINNED_VERSION", workflowVersionId: "v1", input: {} } }] });
    const dependencies = extractDependencies(definition);
    expect(dependencies.map((item) => item.kind)).toEqual(["CONNECTION", "DATA_STORE", "WORKFLOW"]);
    const mapped = applyMappings(definition, dependencies, [{ dependencyKey: dependencies[0].dependencyKey, targetResourceId: "c2" }, { dependencyKey: dependencies[1].dependencyKey, targetResourceId: "s2" }, { dependencyKey: dependencies[2].dependencyKey, targetResourceId: "w2", targetWorkflowVersionId: "v2" }]);
    expect((mapped.steps as any[]).map((step) => step.config)).toEqual(expect.arrayContaining([expect.objectContaining({ connectionId: "c2" }), expect.objectContaining({ dataStoreId: "s2" }), expect.objectContaining({ workflowId: "w2", workflowVersionId: "v2" })]));
  });

  it("classifies dynamic Data Stores as unsupported and blocks sensitive variables", () => {
    const definition = normalizePortableDefinition({ trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "store", name: "Store", type: "data_store_get_record", config: { dataStoreName: "{{variables.store}}", key: "x" } }] });
    expect(extractDependencies(definition)[0].classification).toBe("UNSUPPORTED");
    expect(() => normalizePortableDefinition({ trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [], workflowVariables: { api_token: "not-safe" } })).toThrow(BadRequestException);
    expect(() => normalizePortableDefinition({ trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [], environmentVariables: { database: "postgresql://user:pass@db/app" } })).toThrow(BadRequestException);
  });

  it("sanitizes trigger hints", () => {
    const hints = safeTriggerHints({ triggers: [{ id: "trigger-1", type: "webhook", enabled: true, tokenPreview: "abcd", config: { path: "leads", authorization: "secret" } }, { type: "scheduled", cron: "0 * * * *", nextRunAt: "tomorrow" }] });
    expect(hints).toEqual([{ type: "webhook", config: { path: "leads" } }, { type: "scheduled", cron: "0 * * * *" }]);
    expect(JSON.stringify(hints)).not.toContain("secret");
  });
});
