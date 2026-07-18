import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalsPage from "./page";

const state = vi.hoisted(() => ({
  status: "ready" as "ready" | "loading" | "error",
  calls: [] as Array<[string, number]>,
  data: { items: [] as any[], page: 1, pageSize: 20, total: 0 },
  refetch: vi.fn()
}));

vi.mock("../../features/auth/use-auth", () => ({ useAuth: () => ({ status: "authenticated", activeOrganizationId: "org-1", organizations: [{ id: "org-1", role: "viewer" }] }) }));
vi.mock("../../features/approvals/hooks", () => ({ useApprovals: (status: string, page: number) => { state.calls.push([status, page]); return { isLoading: state.status === "loading", error: state.status === "error" ? new Error("Approval list failed") : null, data: state.status === "ready" ? state.data : undefined, refetch: state.refetch }; } }));

describe("ApprovalsPage", () => {
  beforeEach(() => { state.status = "ready"; state.calls = []; state.data = { items: [], page: 1, pageSize: 20, total: 0 }; state.refetch.mockReset(); });

  it("renders loading, empty, and error states without leaking another tenant", () => {
    state.status = "loading";
    const view = render(<ApprovalsPage />);
    expect(screen.getByText("Loading approvals...")).toBeInTheDocument();
    state.status = "ready";
    view.rerender(<ApprovalsPage />);
    expect(screen.queryAllByRole("row")).toHaveLength(1);
    expect(screen.queryByText("foreign-approval")).not.toBeInTheDocument();
    state.status = "error";
    view.rerender(<ApprovalsPage />);
    expect(screen.getByText(/approval list failed/i)).toBeInTheDocument();
  });

  it("filters server-side and paginates", () => {
    state.data = { items: [{ id: "approval-1", title: "Review payout", workflow: { id: "wf-1", name: "Payments" }, executionId: "execution-123", requestedAt: "2026-07-18T10:00:00Z", expiresAt: null, status: "PENDING" }], page: 1, pageSize: 20, total: 21 };
    render(<ApprovalsPage />);
    expect(screen.getByText("Review payout")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "REJECTED" } });
    expect(state.calls.at(-1)).toEqual(["REJECTED", 1]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(state.calls.at(-1)).toEqual(["REJECTED", 2]);
  });
});
