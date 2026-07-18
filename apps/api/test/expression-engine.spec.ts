import { ExpressionResolver, parseTemplate, validateExpressionString } from "@automation/expression-engine";

describe("expression engine", () => {
  const resolver = new ExpressionResolver();

  it("parses valid paths and preserves complete expression types", () => {
    const parsed = parseTemplate("{{trigger.body.age}}");
    expect(parsed.isSingleExpression).toBe(true);
    expect(resolver.resolveString("{{trigger.body.age}}", { trigger: { body: { age: 42 } } }, { mode: "strict" })).toBe(42);
    expect(resolver.resolveString("Age {{trigger.body.age}}", { trigger: { body: { age: 42 } } }, { mode: "strict" })).toBe("Age 42");
  });

  it("rejects unsupported syntax and dangerous path segments", () => {
    expect(() => parseTemplate("{{trigger.body.email || 'x'}}")).toThrow("Expression syntax is not supported");
    expect(() => parseTemplate("{{trigger.body.__proto__}}")).toThrow("not allowed");
    expect(() => parseTemplate("{{trigger.body.constructor}}")).toThrow("not allowed");
    expect(() => parseTemplate("{{trigger.body.prototype}}")).toThrow("not allowed");
  });

  it("does not traverse prototypes", () => {
    const polluted = Object.create({ secret: "nope" });
    polluted.ok = "yes";
    expect(resolver.resolveString("{{trigger.body.ok}}", { trigger: { body: { ok: "yes" } } }, { mode: "strict" })).toBe("yes");
    expect(resolver.resolveString("{{trigger.body.secret}}", { trigger: { body: polluted } }, { mode: "legacy" })).toBe("");
  });

  it("distinguishes strict and legacy missing path behavior", () => {
    expect(resolver.resolveString("{{trigger.body.missing}}", { trigger: { body: {} } }, { mode: "legacy" })).toBe("");
    expect(() => resolver.resolveString("{{trigger.body.missing}}", { trigger: { body: {} } }, { mode: "strict" })).toThrow("was not found");
  });

  it("validates step ordering and connection allowlist", () => {
    expect(validateExpressionString("{{steps.first.output.value}}", { availableStepKeys: ["first"] }).valid).toBe(true);
    expect(validateExpressionString("{{steps.future.output.value}}", { availableStepKeys: ["first"] }).issues[0].code).toBe("EXPRESSION_STEP_NOT_AVAILABLE");
    expect(validateExpressionString("{{connection.secretValue}}", { allowConnection: true }).issues[0].code).toBe("EXPRESSION_ACCESS_DENIED");
  });

  it("allows transform local item and index namespaces only when enabled", () => {
    expect(validateExpressionString("{{item.id}}", { localNamespaces: ["item", "index"] }).valid).toBe(true);
    expect(validateExpressionString("{{index}}", { localNamespaces: ["item", "index"] }).valid).toBe(true);
    expect(validateExpressionString("{{item.id}}").issues[0].code).toBe("EXPRESSION_NAMESPACE_UNKNOWN");
    expect(resolver.resolveValue({ id: "{{item.id}}", row: "{{index}}" }, { item: { id: "a" }, index: 0 }, { mode: "strict" })).toEqual({ id: "a", row: 0 });
  });

  it("supports variable, execution, workflow, system and timestamp namespaces", () => {
    expect(validateExpressionString("{{variables.customerId}}").valid).toBe(true);
    expect(validateExpressionString("{{execution.variables.customerId}}").valid).toBe(true);
    expect(validateExpressionString("{{workflow.environment.region}}").valid).toBe(true);
    expect(validateExpressionString("{{system.now}}").valid).toBe(true);
    expect(validateExpressionString("{{timestamp}}").valid).toBe(true);
    expect(resolver.resolveValue(
      {
        id: "{{variables.customerId}}",
        same: "{{execution.variables.customerId}}",
        env: "{{workflow.environment.region}}",
        now: "{{system.now}}",
        ts: "{{timestamp}}"
      },
      {
        variables: { customerId: "cus_123" },
        execution: { variables: { customerId: "cus_123" } },
        workflow: { environment: { region: "us" } },
        system: { now: "2026-01-01T00:00:00.000Z" },
        timestamp: "2026-01-01T00:00:00.000Z"
      },
      { mode: "strict" }
    )).toEqual({
      id: "cus_123",
      same: "cus_123",
      env: "us",
      now: "2026-01-01T00:00:00.000Z",
      ts: "2026-01-01T00:00:00.000Z"
    });
  });

  it("rejects unknown namespaces and dangerous variable paths", () => {
    expect(validateExpressionString("{{unknown.value}}").issues[0].code).toBe("EXPRESSION_NAMESPACE_UNKNOWN");
    expect(() => parseTemplate("{{variables.__proto__}}")).toThrow("not allowed");
    expect(() => parseTemplate("{{execution.variables.constructor}}")).toThrow("not allowed");
    expect(() => parseTemplate("{{workflow.environment.prototype}}")).toThrow("not allowed");
  });
});
