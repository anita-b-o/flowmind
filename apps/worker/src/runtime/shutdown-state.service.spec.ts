import { ShutdownStateService } from "./shutdown-state.service";

describe("ShutdownStateService", () => {
  it("is idempotent", () => {
    const service = new ShutdownStateService();
    expect(service.isShuttingDown()).toBe(false);
    service.beginShutdown();
    service.beginShutdown();
    expect(service.isShuttingDown()).toBe(true);
  });
});
