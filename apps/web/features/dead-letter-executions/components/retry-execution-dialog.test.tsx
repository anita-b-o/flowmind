import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api-client";
import { RetryExecutionDialog } from "./retry-execution-dialog";

const { push, mutateAsync, state } = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn(),
  state: { currentError: undefined as unknown }
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../hooks", () => ({
  useRetryExecution: () => ({ mutateAsync, isPending: false, error: state.currentError })
}));

describe("RetryExecutionDialog", () => {
  beforeEach(() => {
    push.mockReset();
    mutateAsync.mockReset();
    state.currentError = undefined;
  });

  it("shows ambiguity and exactly-once warning, sends reason, and navigates on success", async () => {
    mutateAsync.mockResolvedValue({ execution: { id: "retry-1" } });
    render(<RetryExecutionDialog open executionId="execution-1" deadLetterId="dlq-1" onClose={vi.fn()} />);

    expect(screen.getByText(/podrían repetirse/i)).toBeInTheDocument();
    expect(screen.getByText(/no garantiza exactly-once/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/motivo/i), "reviewed");
    await userEvent.click(screen.getByRole("button", { name: /create retry/i }));

    expect(mutateAsync).toHaveBeenCalledWith("reviewed");
    expect(push).toHaveBeenCalledWith("/executions/retry-1");
  });

  it("renders conflict and recoverable enqueue errors", () => {
    state.currentError = new ApiError(409, "conflict");
    const { rerender } = render(<RetryExecutionDialog open executionId="execution-1" onClose={vi.fn()} />);
    expect(screen.getByText(/ya existe un retry activo/i)).toBeInTheDocument();

    state.currentError = new ApiError(503, "recoverable", { recoverable: true });
    rerender(<RetryExecutionDialog open executionId="execution-1" onClose={vi.fn()} />);
    expect(screen.getByText(/no reenvíes automáticamente/i)).toBeInTheDocument();
  });
});
