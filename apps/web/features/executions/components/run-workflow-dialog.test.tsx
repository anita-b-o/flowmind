import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunWorkflowDialog } from "./run-workflow-dialog";

const { push, mutateAsync, state } = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn(),
  state: { isPending: false }
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../hooks", () => ({
  useCreateManualExecution: () => ({ mutateAsync, isPending: state.isPending, error: null })
}));

describe("RunWorkflowDialog", () => {
  beforeEach(() => {
    push.mockReset();
    mutateAsync.mockReset();
    state.isPending = false;
    vi.stubGlobal("crypto", { randomUUID: () => "idem-run-1" });
  });

  it("validates JSON, submits an idempotent manual execution, and navigates to the execution", async () => {
    mutateAsync.mockResolvedValue({ execution: { id: "execution-1" } });
    render(<RunWorkflowDialog open workflowId="workflow-1" workflowName="Lead flow" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/input json/i), { target: { value: "{bad" } });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByText(/json no es válido/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/input json/i), { target: { value: '{ "trigger": { "lead": "Ada" }, "metadata": {} }' } });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      payload: { trigger: { lead: "Ada" }, metadata: {} },
      idempotencyKey: "idem-run-1"
    });
    expect(push).toHaveBeenCalledWith("/executions/execution-1");
  });

  it("disables controls while submitting", () => {
    state.isPending = true;
    render(<RunWorkflowDialog open workflowId="workflow-1" workflowName="Lead flow" onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
  });
});
