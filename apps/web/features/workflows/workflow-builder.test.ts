import { describe, expect, it } from "vitest";
import { emptyStep, keepCompatibleConfig, toWorkflowDefinition, workflowEditorSchema, type WorkflowEditorFormValue } from "./workflow-builder";

describe("workflow builder model", () => {
  it("validates required per-type fields and retry bounds", () => {
    const invalid: WorkflowEditorFormValue = {
      name: "Lead flow",
      description: "",
      steps: [
        {
          ...emptyStep(0, "http_request"),
          config: { connectionId: "", method: "TRACE", url: "", headers: "{}", body: "" },
          retryPolicy: { maxAttempts: 6, backoffMs: 50, strategy: "fixed" },
          timeoutSeconds: 121
        }
      ]
    };

    const result = workflowEditorSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.format())).toContain("URL is required");
      expect(JSON.stringify(result.error.format())).toContain("Method is invalid");
      expect(JSON.stringify(result.error.format())).toContain("Max attempts cannot exceed 5");
    }
  });

  it("serializes form values to the existing create-version DTO", () => {
    const values: WorkflowEditorFormValue = {
      name: "Lead flow",
      description: "",
      steps: [
        {
          ...emptyStep(0, "database_record"),
          key: "save",
          name: "Save",
          config: { collection: "leads", data: "{\"email\":\"{{trigger.body.email}}\"}" }
        }
      ]
    };

    expect(toWorkflowDefinition(values)).toEqual({
      expressionMode: "strict",
      workflowDefinitionSchemaVersion: 2,
      workflowVariables: {},
      environmentVariables: {},
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      graph: { entryStepKey: "save", edges: [], terminalStepKeys: ["save"] },
      steps: [
        {
          key: "save",
          name: "Save",
          type: "database_record",
          config: { collection: "leads", data: { email: "{{trigger.body.email}}" } },
          retryPolicy: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" },
          timeoutSeconds: 30
        }
      ]
    });
  });

  it("serializes variable nodes with structured controls", () => {
    const values: WorkflowEditorFormValue = {
      name: "Variable flow",
      description: "",
      steps: [
        { ...emptyStep(0, "set_variable"), key: "set_customer", name: "Set customer", config: { scope: "execution", name: "customer_id", valueKind: "expression", expression: "{{trigger.body.customerId}}" } },
        { ...emptyStep(1, "get_variable"), key: "get_customer", name: "Get customer", config: { scope: "execution", name: "customer_id" } },
        { ...emptyStep(2, "increment_variable"), key: "increment", name: "Increment", config: { scope: "workflow", name: "count", amount: 2 } },
        { ...emptyStep(3, "append_variable"), key: "append", name: "Append", config: { scope: "execution", name: "items", valueKind: "literal", valueType: "number", value: "7" } }
      ]
    };

    expect(toWorkflowDefinition(values).steps.map((step) => step.config)).toEqual([
      { scope: "execution", name: "customer_id", expression: "{{trigger.body.customerId}}" },
      { scope: "execution", name: "customer_id" },
      { scope: "workflow", name: "count", amount: 2 },
      { scope: "execution", name: "items", value: 7 }
    ]);
  });

  it("serializes if routing into graph v2", () => {
    const values: WorkflowEditorFormValue = {
      name: "Branch flow",
      description: "",
      steps: [
        { ...emptyStep(0, "if"), key: "route", name: "Route", config: { left: "{{trigger.body.kind}}", operator: "equals", right: "vip", trueStepKey: "vip", falseStepKey: "normal" } },
        { ...emptyStep(1, "database_record"), key: "vip", name: "VIP", config: { collection: "leads", data: "{}" } },
        { ...emptyStep(2, "database_record"), key: "normal", name: "Normal", config: { collection: "leads", data: "{}" } }
      ]
    };

    const definition = toWorkflowDefinition(values);
    expect(definition.workflowDefinitionSchemaVersion).toBe(2);
    expect(definition.graph?.edges).toEqual(
      expect.arrayContaining([
        { from: "route", to: "vip", kind: "if_true", label: "true" },
        { from: "route", to: "normal", kind: "if_false", label: "false" },
        { from: "vip", to: "normal", kind: "next" }
      ])
    );
  });

  it("serializes and validates Transform configs", () => {
    const values: WorkflowEditorFormValue = {
      name: "Transform flow",
      description: "",
      steps: [
        {
          ...emptyStep(0, "transform"),
          key: "shape",
          name: "Shape",
          config: { mode: "MAP_ARRAY", source: "{{trigger.body.items}}", template: "{\"id\":\"{{item.id}}\",\"row\":\"{{index}}\"}", outputType: "ARRAY" }
        }
      ]
    };

    expect(workflowEditorSchema.safeParse(values).success).toBe(true);
    expect(toWorkflowDefinition(values).steps[0]).toMatchObject({
      type: "transform",
      config: {
        configVersion: 1,
        mode: "MAP_ARRAY",
        source: "{{trigger.body.items}}",
        template: { id: "{{item.id}}", row: "{{index}}" },
        itemVariable: "item",
        outputType: "ARRAY"
      }
    });
  });

  it("ignores Transform OBJECT editor metadata and serializes scalar output values", () => {
    const values: WorkflowEditorFormValue = {
      name: "Transform flow",
      description: "",
      steps: [
        {
          ...emptyStep(0, "transform"),
          key: "shape",
          name: "Shape",
          config: {
            mode: "OBJECT",
            fields: "{\"value\":123}",
            fieldsUi: "[{\"key\":\"value\",\"kind\":\"literal\",\"value\":\"123\"}]",
            outputType: "NUMBER"
          }
        }
      ]
    };

    expect(workflowEditorSchema.safeParse(values).success).toBe(true);
    expect(toWorkflowDefinition(values).steps[0]).toMatchObject({
      type: "transform",
      config: {
        configVersion: 1,
        mode: "OBJECT",
        fields: { value: 123 },
        outputType: "NUMBER"
      }
    });
    expect(toWorkflowDefinition(values).steps[0].config).not.toHaveProperty("fieldsUi");
  });

  it("rejects unsafe Transform paths inline", () => {
    const invalid: WorkflowEditorFormValue = {
      name: "Transform flow",
      description: "",
      steps: [{ ...emptyStep(0, "transform"), config: { mode: "PICK", source: "{{trigger.body}}", paths: "__proto__.polluted" } }]
    };

    const result = workflowEditorSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.format())).toContain("Path is invalid or unsafe");
  });

  it("drops incompatible config when type changes", () => {
    expect(keepCompatibleConfig("email_notification", { url: "https://example.com", subject: "Hello" })).toEqual({
      connectionId: "",
      to: "",
      subject: "Hello",
      text: ""
    });
  });
});
