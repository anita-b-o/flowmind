import { StepType, TRANSFORM_LIMITS, validateTransformStepConfig } from "@automation/shared-types";
import { ErrorClassifier } from "../error-classifier";
import { ExpressionResolver } from "../expression-resolver";
import { convertTransformOutput, executeTransform, TransformHandler, TransformStepError } from "./transform.handler";

const context = {
  trigger: {
    body: {
      id: "lead-1",
      name: "Ada",
      email: null,
      profile: { score: 42, secret: "hide" },
      items: [{ id: "a", active: true }, { id: "b", active: false }]
    },
    headers: { authorization: "secret" },
    query: {}
  },
  steps: { lookup: { output: { owner: "sales", id: "existing" }, status: "COMPLETED" } },
  metadata: { expressionMode: "strict" }
} as any;

describe("Transform contract validation", () => {
  it.each([
    [{ mode: "OBJECT", fields: { id: "{{trigger.body.id}}" } }],
    [{ mode: "PICK", source: "{{trigger.body}}", paths: ["id"] }],
    [{ mode: "OMIT", source: "{{trigger.body}}", paths: ["profile.secret"] }],
    [{ mode: "MAP_ARRAY", source: "{{trigger.body.items}}", template: { id: "{{item.id}}" } }],
    [{ mode: "FILTER_ARRAY", source: "{{trigger.body.items}}", condition: "{{item.active}}" }],
    [{ mode: "MERGE", mergeSources: ["{{trigger.body.profile}}", "{{steps.lookup.output}}"], conflictPolicy: "LAST_WINS" }]
  ])("accepts valid config %#", (config) => {
    expect(validateTransformStepConfig(config)).toEqual([]);
  });

  it("rejects incompatible properties, invalid modes, dangerous keys, dangerous paths and config limits", () => {
    expect(validateTransformStepConfig({ mode: "PICK", fields: {}, source: "{}", paths: ["id"] })[0].code).toBe("incompatible_property");
    expect(validateTransformStepConfig({ mode: "NOPE" })[0].code).toBe("invalid_mode");
    expect(validateTransformStepConfig({ mode: "OBJECT", fields: { ["__proto__"]: "x" } })[0].code).toBe("dangerous_key");
    expect(validateTransformStepConfig({ mode: "OBJECT", fields: JSON.parse("{\"nested\":{\"constructor\":\"x\"}}") }).some((issue) => issue.code === "dangerous_key")).toBe(true);
    expect(validateTransformStepConfig({ mode: "OBJECT", fields: { other: "123" }, outputType: "NUMBER" }).some((issue) => issue.code === "invalid_output_type")).toBe(true);
    expect(validateTransformStepConfig({ mode: "PICK", source: "{}", paths: ["__proto__.polluted"] })[0].code).toBe("invalid_path");
    expect(validateTransformStepConfig({ mode: "PICK", source: "{}", paths: ["safe.constructor"] })[0].code).toBe("invalid_path");
    expect(validateTransformStepConfig({ mode: "OBJECT", fields: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, index])) }).some((issue) => issue.code === "config_limit_exceeded")).toBe(true);
  });
});

describe("TransformHandler", () => {
  it("builds OBJECT outputs with literals, typed expressions, nested objects, arrays, null and missing errors", () => {
    const output = executeTransform(
      {
        mode: "OBJECT",
        fields: {
          id: "{{trigger.body.id}}",
          count: 2,
          nested: { score: "{{trigger.body.profile.score}}" },
          list: ["{{trigger.body.name}}"],
          email: "{{trigger.body.email}}"
        }
      },
      context
    );
    expect(output).toEqual({ id: "lead-1", count: 2, nested: { score: 42 }, list: ["Ada"], email: null });
    expect(() => executeTransform({ mode: "OBJECT", fields: { missing: "{{trigger.body.nope}}" } }, context)).toThrow(TransformStepError);
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: undefined } }, context)).toThrow("JSON serializable");
  });

  it("picks and omits nested paths without mutating input or allowing prototype pollution", () => {
    const frozenContext = deepFreeze(JSON.parse(JSON.stringify(context)));
    const original = JSON.parse(JSON.stringify(frozenContext.trigger.body));
    const picked = executeTransform({ mode: "PICK", source: "{{trigger.body}}", paths: ["id", "profile.score", "missing"] }, frozenContext);
    expect(picked).toEqual({ id: "lead-1", profile: { score: 42 } });
    expect(executeTransform({ mode: "OMIT", source: "{{trigger.body}}", paths: ["profile.secret", "missing"] }, frozenContext)).toEqual({ ...original, profile: { score: 42 } });
    expect(frozenContext.trigger.body).toEqual(original);
    expect((picked as any).profile).not.toBe(frozenContext.trigger.body.profile);
    expect(() => executeTransform({ mode: "OMIT", source: "{{trigger.body}}", paths: ["constructor.polluted"] }, context)).toThrow("Path is invalid");
  });

  it("merges shallow objects with explicit conflict policies", () => {
    const first = deepFreeze({ a: 1, nested: { keep: true }, same: "first" });
    const second = deepFreeze({ b: 2, same: "last" });
    expect(executeTransform({ mode: "MERGE", mergeSources: [first, second], conflictPolicy: "LAST_WINS" }, context)).toEqual({ a: 1, nested: { keep: true }, same: "last", b: 2 });
    expect(executeTransform({ mode: "MERGE", mergeSources: [{ a: 1, same: "first" }, { b: 2, same: "last" }], conflictPolicy: "FIRST_WINS" }, context)).toEqual({ a: 1, same: "first", b: 2 });
    expect(executeTransform({ mode: "MERGE", mergeSources: [{ same: { value: 1 } }, { same: { value: 1 } }], conflictPolicy: "ERROR" }, context)).toEqual({ same: { value: 1 } });
    expect(() => executeTransform({ mode: "MERGE", mergeSources: [{ same: "first" }, { same: "last" }], conflictPolicy: "ERROR" }, context)).toThrow("MERGE conflict");
    expect(() => executeTransform({ mode: "MERGE", mergeSources: [{ a: 1 }, "x"], conflictPolicy: "LAST_WINS" }, context)).toThrow("must resolve to an object");
    expect(() => executeTransform({ mode: "MERGE", mergeSources: [dangerousObject("__proto__"), {}], conflictPolicy: "LAST_WINS" }, context)).toThrow("not allowed");
    expect(first).toEqual({ a: 1, nested: { keep: true }, same: "first" });
  });

  it("maps arrays with item/index, handles empty arrays, enforces array and output limits, and does not mutate", () => {
    const original = JSON.parse(JSON.stringify(context.trigger.body.items));
    expect(executeTransform({ mode: "MAP_ARRAY", source: "{{trigger.body.items}}", template: { id: "{{item.id}}", index: "{{index}}" } }, context)).toEqual([
      { id: "a", index: 0 },
      { id: "b", index: 1 }
    ]);
    expect(executeTransform({ mode: "MAP_ARRAY", source: [], template: "{{item}}" }, context)).toEqual([]);
    expect(context.trigger.body.items).toEqual(original);
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: "{{trigger.body.id}}", template: "{{item}}" }, context)).toThrow("must resolve to an array");
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: Array.from({ length: 1001 }, (_, index) => index), template: "{{item}}" }, context)).toThrow("more than 1000");
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: [1], template: "x".repeat(33_000) }, context)).toThrow("string length");
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: [{ ok: true }, {}], template: "{{item.missing}}" }, context)).toThrow("index");
  });

  it("filters arrays with boolean conditions and rejects non-booleans", () => {
    expect(executeTransform({ mode: "FILTER_ARRAY", source: "{{trigger.body.items}}", condition: "{{item.active}}" }, context)).toEqual([{ id: "a", active: true }]);
    expect(executeTransform({ mode: "FILTER_ARRAY", source: [], condition: true }, context)).toEqual([]);
    expect(executeTransform({ mode: "FILTER_ARRAY", source: [{ keep: false }, { keep: true }], condition: "{{item.keep}}" }, context)).toEqual([{ keep: true }]);
    expect(() => executeTransform({ mode: "FILTER_ARRAY", source: [0, 1], condition: "{{index}}" }, context)).toThrow("must resolve to a boolean");
    expect(() => executeTransform({ mode: "FILTER_ARRAY", source: "no", condition: true }, context)).toThrow("must resolve to an array");
  });

  it("converts output types explicitly", () => {
    expect(convertTransformOutput(123, "STRING")).toBe("123");
    expect(convertTransformOutput("123", "NUMBER")).toBe(123);
    expect(convertTransformOutput("false", "BOOLEAN")).toBe(false);
    expect(convertTransformOutput({ value: 1 }, "OBJECT")).toEqual({ value: 1 });
    expect(convertTransformOutput([1], "ARRAY")).toEqual([1]);
    expect(executeTransform({ mode: "OBJECT", fields: { value: "123" }, outputType: "NUMBER" }, context)).toBe(123);
    expect(executeTransform({ mode: "OBJECT", fields: { value: "false" }, outputType: "BOOLEAN" }, context)).toBe(false);
    expect(executeTransform({ mode: "OBJECT", fields: { value: 123 }, outputType: "STRING" }, context)).toBe("123");
    expect(() => convertTransformOutput("nope", "NUMBER")).toThrow("converted to number");
    expect(() => convertTransformOutput(Number.NaN, "NUMBER")).toThrow("converted to number");
    expect(() => convertTransformOutput("False", "BOOLEAN")).toThrow("converted to boolean");
    expect(() => executeTransform({ mode: "OBJECT", fields: { other: "123" }, outputType: "STRING" }, context)).toThrow("requires exactly one field");
  });

  it("enforces boundaries, depth, size and JSON-only outputs", () => {
    expect(executeTransform({ mode: "MAP_ARRAY", source: Array.from({ length: TRANSFORM_LIMITS.maxArrayItems }, (_, index) => index), template: "{{item}}" }, context)).toHaveLength(TRANSFORM_LIMITS.maxArrayItems);
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: Array.from({ length: TRANSFORM_LIMITS.maxArrayItems + 1 }, (_, index) => index), template: "{{item}}" }, context)).toThrow("more than 1000");
    expect(() => executeTransform({ mode: "OBJECT", fields: deepObject(TRANSFORM_LIMITS.maxDepth + 1) }, context)).toThrow("depth limit");
    expect(() =>
      executeTransform(
        { mode: "OBJECT", fields: { value: "{{trigger.body.long}}" } },
        { ...context, trigger: { ...context.trigger, body: { long: "x".repeat(TRANSFORM_LIMITS.maxOutputBytes + 1) } } }
      )
    ).toThrow("string length");
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: Number.POSITIVE_INFINITY } }, context)).toThrow("finite");
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: "{{trigger.body.big}}" } }, { ...context, trigger: { ...context.trigger, body: { big: BigInt(1) } } })).toThrow("JSON serializable");
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: "{{trigger.body.fn}}" } }, { ...context, trigger: { ...context.trigger, body: { fn: () => "nope" } } })).toThrow("JSON serializable");
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: "{{trigger.body.symbol}}" } }, { ...context, trigger: { ...context.trigger, body: { symbol: Symbol("nope") } } })).toThrow("JSON serializable");
    expect(() => executeTransform({ mode: "OBJECT", fields: { value: "{{trigger.body.unsafe}}" } }, { ...context, trigger: { ...context.trigger, body: { unsafe: dangerousObject("constructor") } } })).toThrow("not allowed");
    expect(() => executeTransform({ mode: "MAP_ARRAY", source: [dangerousObject("prototype")], template: "{{item}}" }, context)).toThrow("not allowed");
  });

  it("classifies Transform errors as non retryable", () => {
    const classifier = new ErrorClassifier();
    const errors = [
      () => executeTransform({ mode: "NOPE" } as any, context),
      () => executeTransform({ mode: "PICK", source: "x", paths: ["id"] }, context),
      () => executeTransform({ mode: "PICK", source: {}, paths: ["constructor.polluted"] }, context),
      () => executeTransform({ mode: "OBJECT", fields: { value: "x" }, outputType: "NUMBER" }, context),
      () => executeTransform({ mode: "MERGE", mergeSources: [{ a: 1 }, { a: 2 }], conflictPolicy: "ERROR" }, context)
    ];
    for (const run of errors) {
      try {
        run();
        throw new Error("expected transform failure");
      } catch (error) {
        expect(classifier.classify(error)).toBe("non_retryable");
      }
    }
  });

  it("runs through the handler and returns unwrapped JSON output", async () => {
    const handler = new TransformHandler(new ExpressionResolver());
    const result = await handler.execute({ key: "transform", name: "Transform", type: StepType.Transform, position: 1, config: { mode: "OBJECT", fields: { id: "{{trigger.body.id}}" } } }, context);
    expect(result.output).toEqual({ id: "lead-1" });
  });
});

function dangerousObject(key: string) {
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, key, { value: "polluted", enumerable: true });
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  return value;
}

function deepObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}
