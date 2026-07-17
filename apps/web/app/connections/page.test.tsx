import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConnectionsPage from "./page";

const state = vi.hoisted(() => ({
  role: "admin",
  query: {
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    data: [
      {
        id: "conn-1",
        type: "HTTP",
        authScheme: "BEARER",
        name: "Primary API",
        description: "Production",
        status: "ACTIVE",
        maskedCredential: "Authorization: Bearer ********abcd",
        usageCount: 2,
        usage: [],
        lastTest: { testedAt: new Date("2026-01-01T10:00:00Z").toISOString(), status: "SUCCESS", statusCode: 200, durationMs: 22 },
        createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
        updatedAt: new Date("2026-01-01T10:00:00Z").toISOString(),
        rotatedAt: null
      }
    ]
  }
}));

vi.mock("../../features/auth/use-auth", () => ({
  useAuth: () => ({
    status: "authenticated",
    activeOrganizationId: "org-1",
    organizations: [{ id: "org-1", role: state.role }]
  })
}));

vi.mock("../../features/connections/hooks", () => ({
  useConnections: () => state.query,
  useCreateConnection: () => mutation(),
  useUpdateConnection: () => mutation(),
  useRotateConnection: () => mutation(),
  useEnableConnection: () => mutation(),
  useDisableConnection: () => mutation(),
  useDeleteConnection: () => mutation(),
  useTestConnection: () => ({ ...mutation(), data: undefined, reset: vi.fn() })
}));

describe("ConnectionsPage", () => {
  it("renders safe connection metadata for admins", () => {
    render(<ConnectionsPage />);
    expect(screen.getByText("Primary API")).toBeInTheDocument();
    expect(screen.getByText("HTTP BEARER")).toBeInTheDocument();
    expect(screen.getByText("Authorization: Bearer ********abcd")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("bearer-secret")).not.toBeInTheDocument();
  });

  it("hides connection rows from viewers", () => {
    state.role = "viewer";
    render(<ConnectionsPage />);
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("Primary API")).not.toBeInTheDocument();
    state.role = "admin";
  });
});

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };
}
