import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuditLogPage from "./page";

const state = vi.hoisted(() => ({
  role: "admin",
  query: {
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    data: {
      items: [
        {
          id: "audit-1",
          action: "execution.retry_requested",
          resourceType: "Execution",
          resourceId: "execution-123456",
          actor: { id: "user-1", display: "Ada" },
          correlationId: "correlation-1",
          metadata: { token: "secret", retryExecutionId: "retry-1" },
          createdAt: new Date().toISOString()
        }
      ],
      page: 1,
      pageSize: 20,
      total: 1
    }
  }
}));

vi.mock("../../features/auth/use-auth", () => ({
  useAuth: () => ({
    status: "authenticated",
    activeOrganizationId: "org-1",
    organizations: [{ id: "org-1", role: state.role }]
  })
}));

vi.mock("../../features/audit-log/hooks", () => ({
  useAuditLogs: () => state.query
}));

describe("AuditLogPage", () => {
  it("renders audit rows for admins and redacts metadata", () => {
    render(<AuditLogPage />);
    expect(screen.getByText("execution.retry_requested")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("correlation-1")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("hides audit rows from viewers", () => {
    state.role = "viewer";
    render(<AuditLogPage />);
    expect(screen.getByText(/only owners and admins/i)).toBeInTheDocument();
    expect(screen.queryByText("execution.retry_requested")).not.toBeInTheDocument();
    state.role = "admin";
  });
});
