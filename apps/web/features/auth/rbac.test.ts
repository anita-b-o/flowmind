import { describe, expect, it } from "vitest";
import { canRetryExecution, canViewAuditLog, canViewDeadLetters } from "./rbac";

describe("frontend RBAC helpers", () => {
  it("matches DLQ, retry and audit permissions", () => {
    expect(canViewDeadLetters("viewer")).toBe(false);
    expect(canViewDeadLetters("admin")).toBe(true);
    expect(canRetryExecution("viewer")).toBe(false);
    expect(canRetryExecution("editor")).toBe(true);
    expect(canViewAuditLog("editor")).toBe(false);
    expect(canViewAuditLog("admin")).toBe(true);
    expect(canViewAuditLog("owner")).toBe(true);
  });
});
