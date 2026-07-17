import { BadRequestException } from "@nestjs/common";
import { ScheduledCronService } from "./scheduled-cron.service";

describe("ScheduledCronService", () => {
  const originalEnv = { ...process.env };
  let service: ScheduledCronService;

  beforeEach(() => {
    process.env = { ...originalEnv };
    service = new ScheduledCronService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("accepts standard cron and calculates next runs in an IANA timezone", () => {
    const result = service.validate("0 9 * * 1-5", "America/New_York");

    expect(result.cron).toBe("0 9 * * 1-5");
    expect(result.bullPattern).toBe("0 0 9 * * 1-5");
    expect(result.nextRuns).toHaveLength(3);
  });

  it("rejects invalid cron and timezone values with clear errors", () => {
    expect(() => service.validate("* * *", "UTC")).toThrow(BadRequestException);
    expect(() => service.validate("0 9 * * *", "Mars/Base")).toThrow("Timezone must be a valid IANA timezone");
  });

  it("enforces the configurable minimum frequency", () => {
    process.env.SCHEDULED_TRIGGER_MIN_INTERVAL_SECONDS = "120";

    expect(() => service.validate("* * * * *", "UTC")).toThrow("Cron frequency must be at least 120 seconds");
  });

  it("handles daylight saving transitions with timezone-aware next runs", () => {
    const runs = service.nextRuns("30 2 * * *", "America/New_York", 3, new Date("2026-03-07T00:00:00.000Z"));

    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z"
    ]);
  });
});
