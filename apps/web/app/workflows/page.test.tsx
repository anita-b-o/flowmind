import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowsPage from "./page";

const { push, createWorkflow, workflows } = vi.hoisted(() => ({
  push: vi.fn(),
  createWorkflow: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn()
  },
  workflows: {
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn()
  }
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../../features/auth/use-auth", () => ({
  useAuth: () => ({ status: "authenticated" })
}));
vi.mock("../../features/workflows/hooks", () => ({
  useWorkflows: () => workflows,
  useCreateWorkflow: () => createWorkflow
}));

describe("WorkflowsPage", () => {
  beforeEach(() => {
    push.mockReset();
    createWorkflow.mutateAsync.mockReset();
  });

  it("creates a workflow and navigates to its editor", async () => {
    createWorkflow.mutateAsync.mockResolvedValue({ id: "workflow-new" });
    render(<WorkflowsPage />);

    await userEvent.type(screen.getByLabelText("Name"), "Lead flow");
    await userEvent.click(screen.getByRole("button", { name: /create workflow/i }));

    await waitFor(() => expect(createWorkflow.mutateAsync).toHaveBeenCalledWith({ name: "Lead flow", description: "" }));
    expect(push).toHaveBeenCalledWith("/workflows/workflow-new");
  });
});
