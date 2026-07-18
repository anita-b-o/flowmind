import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionApprovalDetails } from "../../../features/executions/components/execution-approval-details";

const base = { id: "approval-1", title: "Review payout", stepKey: "approval", requestedAt: "2026-07-18T10:00:00.000Z", expiresAt: "2026-07-19T10:00:00.000Z", decidedAt: null };

describe("ExecutionApprovalDetails", () => {
  it("renders a safe durable waiting state with timestamps and approval link", () => {
    render(<ExecutionApprovalDetails waitReason="approval" approvals={[{ ...base, status: "PENDING" }]} />);
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review payout" })).toHaveAttribute("href", "/approvals/approval-1");
    expect(document.body.textContent).toMatch(/requested/i);
    expect(document.body.textContent).toMatch(/expires/i);
  });

  it.each(["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"])("renders terminal %s metadata without internal context", (status) => {
    render(<ExecutionApprovalDetails waitReason={null} approvals={[{ ...base, status, decidedAt: "2026-07-18T11:00:00.000Z" }]} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/decided/i);
    expect(document.body.textContent).not.toMatch(/contextJson|variables|authorization|headers|bearer|token|secret|payload/i);
  });
});
