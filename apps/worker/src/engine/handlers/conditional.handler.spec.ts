import { StepType } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { ConditionalHandler } from "./conditional.handler";

describe("ConditionalHandler", () => {
  const handler = new ConditionalHandler(new ExpressionResolver());
  const context = { trigger: {}, steps: {}, metadata: {} } as any;

  it("continues normally when the legacy condition passes", async () => {
    const result = await handler.execute({ key: "condition", name: "Condition", type: StepType.Conditional, position: 1, config: { left: "yes", operator: "equals", right: "yes", skipNextOnFalse: true } }, context);

    expect(result.output).toEqual({ passed: true });
    expect(result.control).toEqual({ skipNext: false });
  });

  it("requests exactly one linear skip when the legacy condition fails", async () => {
    const result = await handler.execute({ key: "condition", name: "Condition", type: StepType.Conditional, position: 1, config: { left: "no", operator: "equals", right: "yes", skipNextOnFalse: true } }, context);

    expect(result.output).toEqual({ passed: false });
    expect(result.control).toEqual({ skipNext: true });
  });
});
