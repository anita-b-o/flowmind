import { parseDurationMs, parseWaitUntil } from "./wait-time-parser";

describe("wait time parser", () => {
  it("parses fixed durations", () => {
    expect(parseDurationMs("30 seconds")).toBe(30_000);
    expect(parseDurationMs("5 minutes")).toBe(300_000);
    expect(parseDurationMs("2 hours")).toBe(7_200_000);
  });

  it("rejects negative, zero and unsupported durations", () => {
    expect(() => parseDurationMs("0 seconds")).toThrow("Delay duration");
    expect(() => parseDurationMs("-1 minutes")).toThrow("Delay duration");
    expect(() => parseDurationMs("tomorrow")).toThrow("Delay duration");
  });

  it("parses valid wait-until timestamps", () => {
    expect(parseWaitUntil("2026-07-16T12:00:00.000Z").toISOString()).toBe("2026-07-16T12:00:00.000Z");
  });
});
