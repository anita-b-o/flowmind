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
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
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

  it("drops incompatible config when type changes", () => {
    expect(keepCompatibleConfig("email_notification", { url: "https://example.com", subject: "Hello" })).toEqual({
      connectionId: "",
      to: "",
      subject: "Hello",
      text: ""
    });
  });
});
