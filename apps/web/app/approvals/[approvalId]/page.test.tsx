import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalDetailPage from "./page";

const state = vi.hoisted(() => ({ role: "viewer", status: "PENDING", allowedRoles: ["editor"], isPending: false, mutate: vi.fn(), error: null as Error | null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ approvalId: "approval-1" }) }));
vi.mock("../../../features/auth/use-auth", () => ({ useAuth: () => ({ status: "authenticated", activeOrganizationId: "org-1", organizations: [{ id: "org-1", role: state.role }] }) }));
vi.mock("../../../features/approvals/hooks", () => ({
  useApproval: () => ({ error: null, refetch: vi.fn(), data: { id: "approval-1", title: "Review payout", description: "Plain safe context", summary: "Summary", status: state.status, allowedRoles: state.allowedRoles, workflow: { id: "wf-1", name: "Payments" }, executionId: "execution-1", requestedAt: "2026-07-18T10:00:00Z", expiresAt: "2026-07-19T10:00:00Z" } }),
  useDecideApproval: () => ({ mutate: state.mutate, isPending: state.isPending, error: state.error })
}));

describe("ApprovalDetailPage", () => {
  beforeEach(() => { state.role = "viewer"; state.status = "PENDING"; state.allowedRoles = ["editor"]; state.isPending = false; state.error = null; state.mutate.mockReset(); });

  it("lets viewers inspect safe detail but not decide", () => {
    render(<ApprovalDetailPage />);
    expect(screen.getByText("Review payout")).toBeInTheDocument();
    expect(screen.getByText("Plain safe context")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/contextJson|authorization|secret|token/i);
  });

  it.each(["admin", "owner"])("allows %s to approve with confirmation and comment", (role) => {
    state.role = role;
    render(<ApprovalDetailPage />);
    fireEvent.change(screen.getByLabelText("Optional comment"), { target: { value: "Approved after review" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog", { name: "Approve request?" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" }).at(-1)!);
    expect(state.mutate).toHaveBeenCalledWith({ decision: "approve", comment: "Approved after review" }, expect.any(Object));
  });

  it("enforces editor allowedRoles and confirms rejection", () => {
    state.role = "editor";
    const view = render(<ApprovalDetailPage />);
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    expect(state.mutate).toHaveBeenCalledWith({ decision: "reject", comment: "" }, expect.any(Object));
    state.allowedRoles = ["admin"];
    view.rerender(<ApprovalDetailPage />);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("blocks double submit and disables terminal decisions", () => {
    state.role = "admin"; state.isPending = true;
    const view = render(<ApprovalDetailPage />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    state.isPending = false; state.status = "APPROVED";
    view.rerender(<ApprovalDetailPage />);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText("APPROVED")).toBeInTheDocument();
  });
});
