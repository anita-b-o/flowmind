import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDetail, WorkflowVersion } from "../types";
import { WorkflowEditor } from "./workflow-editor";

const { replace, createVersion, activateVersion } = vi.hoisted(() => ({
  replace: vi.fn(),
  createVersion: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn()
  },
  activateVersion: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn()
  }
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/workflows/workflow-1",
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("../hooks", () => ({
  useCreateWorkflowVersion: () => createVersion,
  useActivateWorkflowVersion: () => activateVersion
}));

vi.mock("../../connections/hooks", () => ({
  useConnections: ({ type }: { type: string }) => ({
    data:
      type === "SMTP"
        ? [{ id: "smtp-1", name: "SMTP primary", credential: "te****@example.com", type: "SMTP", status: "ACTIVE" }]
        : [{ id: "http-1", name: "API primary", credential: "Authorization: ****", type: "HTTP_API_KEY", status: "ACTIVE" }],
    isLoading: false
  })
}));

describe("WorkflowEditor", () => {
  beforeEach(() => {
    replace.mockReset();
    createVersion.mutateAsync.mockReset();
    activateVersion.mutateAsync.mockReset();
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("adds, removes, reorders, validates, and creates a version", async () => {
    createVersion.mutateAsync.mockResolvedValue(version("version-2", 2, "DRAFT", []));
    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText("Step type to add"), "email_notification");
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(screen.getAllByDisplayValue("Email").length).toBeGreaterThan(0);

    await userEvent.clear(screen.getByPlaceholderText("sales@example.com"));
    await userEvent.click(screen.getByRole("button", { name: /create version/i }));
    expect(await screen.findByText("Recipient is required.")).toBeInTheDocument();
    expect(createVersion.mutateAsync).not.toHaveBeenCalled();

    await userEvent.type(screen.getByPlaceholderText("sales@example.com"), "sales@example.com");
    await userEvent.selectOptions(screen.getByLabelText(/connection/i), "smtp-1");
    await userEvent.type(screen.getByRole("textbox", { name: /subject/i }), "Lead");
    await userEvent.type(screen.getByRole("textbox", { name: /body/i }), "Hello");

    const cards = document.querySelectorAll(".step-card");
    fireEvent.dragStart(cards[1]);
    fireEvent.drop(cards[0]);
    await waitFor(() => expect((document.querySelector('input[name="steps.0.name"]') as HTMLInputElement).value).toBe("Email"));

    await userEvent.click(screen.getAllByRole("button", { name: /delete/i })[1]);
    expect(screen.queryByDisplayValue("Save lead")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /create version/i }));
    await waitFor(() => expect(createVersion.mutateAsync).toHaveBeenCalled());
    expect(createVersion.mutateAsync.mock.calls[0][0].steps[0].type).toBe("email_notification");
  });

  it("changes type with a warning and discards local draft changes", async () => {
    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.selectOptions(screen.getAllByLabelText("Type")[0], "http_request");
    expect(window.alert).toHaveBeenCalledWith("Step type changed. Incompatible configuration fields were removed.");
    expect(screen.getByText(/incompatible configuration fields were removed/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("textbox", { name: /workflow name/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /workflow name/i }), "Changed");
    expect(screen.getByText("Unsaved draft")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(screen.getByRole("textbox", { name: /workflow name/i })).toHaveValue("Lead intake");
  });

  it("opens read-only history and activates versions explicitly", async () => {
    const onRefresh = vi.fn();
    activateVersion.mutateAsync.mockResolvedValue({});
    render(<WorkflowEditor workflow={workflow()} onRefresh={onRefresh} />);

    await userEvent.click(screen.getByRole("button", { name: /v1 archived/i }));
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Workflow name")).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /activate version/i }));
    await userEvent.click(screen.getAllByRole("button", { name: /^activate version$/i }).at(-1)!);
    await waitFor(() => expect(activateVersion.mutateAsync).toHaveBeenCalledWith("version-1"));
    expect(onRefresh).toHaveBeenCalled();
  });
});

function workflow(): WorkflowDetail {
  const latestSteps = [
    {
      id: "step-1",
      key: "save_lead",
      name: "Save lead",
      type: "database_record" as const,
      position: 1,
      configJson: { collection: "leads", data: { email: "{{trigger.body.email}}" } },
      retryPolicyJson: { retry: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" } },
      timeoutSeconds: 30
    }
  ];
  return {
    id: "workflow-1",
    name: "Lead intake",
    description: "",
    status: "ACTIVE",
    activeVersionId: "version-2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    versions: [
      version("version-1", 1, "ARCHIVED", latestSteps),
      version("version-2", 2, "ACTIVE", latestSteps)
    ]
  };
}

function version(id: string, versionNumber: number, status: WorkflowVersion["status"], steps: WorkflowVersion["steps"]): WorkflowVersion {
  return {
    id,
    versionNumber,
    status,
    definitionJson: { trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    activatedAt: status === "ACTIVE" ? "2026-01-01T00:00:00.000Z" : null,
    createdBy: { id: "user-1", email: "ada@example.com", name: "Ada" },
    steps: [
      { id: `${id}-trigger`, key: "webhook", name: "Webhook", type: "webhook_trigger", position: 0, configJson: {} },
      ...steps
    ]
  };
}
