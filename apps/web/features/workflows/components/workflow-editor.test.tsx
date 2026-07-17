import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDetail, WorkflowVersion } from "../types";
import { WorkflowEditor } from "./workflow-editor";
import { saveDraftSnapshot } from "../draft-autosave";
import { workflowVersionToDraft } from "../draft-adapters";

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
  useActivateWorkflowVersion: () => activateVersion,
  useWorkflowTestRuns: () => ({ data: { items: [] } }),
  useCreateWorkflowTestRun: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWorkflowTestRun: () => ({ data: undefined }),
  useCancelWorkflowTestRun: () => ({ mutate: vi.fn() }),
  useRerunWorkflowTestRun: () => ({ mutate: vi.fn() }),
  useSkipTestWait: () => ({ mutate: vi.fn() }),
  useCompareTestRunWithLastReal: () => ({ data: undefined })
}));

vi.mock("../../auth/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "ada@example.com" },
    activeOrganizationId: "org-1",
    organizations: [{ id: "org-1", role: "owner" }]
  })
}));

vi.mock("../../connections/hooks", () => ({
  useConnections: ({ type }: { type: string }) => ({
    data:
      type === "SMTP"
        ? [{ id: "smtp-1", name: "SMTP primary", credential: "te****@example.com", type: "SMTP", status: "ACTIVE" }]
        : [{ id: "http-1", name: "API primary", credential: "Authorization: ****", maskedCredential: "Authorization: ****", type: "HTTP", authScheme: "API_KEY", status: "ACTIVE", usageCount: 0 }],
    isLoading: false
  })
}));

describe("WorkflowEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    replace.mockReset();
    createVersion.mutateAsync.mockReset();
    createVersion.isPending = false;
    createVersion.error = null;
    activateVersion.mutateAsync.mockReset();
    activateVersion.isPending = false;
    activateVersion.error = null;
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("adds, removes, reorders, validates, and creates a version", async () => {
    createVersion.mutateAsync.mockResolvedValue(version("version-2", 2, "DRAFT", []));
    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Form" }));
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

    await userEvent.click(screen.getByRole("button", { name: "Form" }));
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

  it("shows save errors and prevents duplicate save requests while pending", async () => {
    createVersion.mutateAsync.mockRejectedValue(new Error("Backend rejected graph"));
    const { rerender } = render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.clear(screen.getByRole("textbox", { name: /workflow name/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /workflow name/i }), "Changed flow");
    await userEvent.click(screen.getByRole("button", { name: /create version/i }));
    await waitFor(() => expect(screen.getAllByText("Save error").length).toBeGreaterThan(0));

    createVersion.mutateAsync.mockReset();
    createVersion.isPending = true;
    rerender(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
  });

  it("detects and restores a local autosave snapshot", async () => {
    const draft = workflowVersionToDraft(workflow(), workflow().versions.at(-1));
    draft.workflowMeta.name = "Recovered flow";
    saveDraftSnapshot(localStorage, { userId: "user-1", organizationId: "org-1", workflowId: "workflow-1", versionId: "version-2" }, draft);

    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    expect(await screen.findByRole("dialog", { name: /recover local workflow draft/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /restore local copy/i }));
    expect(screen.getByRole("textbox", { name: /workflow name/i })).toHaveValue("Recovered flow");
    expect(screen.getAllByText("Recovered local changes").length).toBeGreaterThan(0);
  });

  it("requires an explicit debugger source when local changes exist", async () => {
    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.clear(screen.getByRole("textbox", { name: /workflow name/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /workflow name/i }), "Changed flow");
    await userEvent.click(screen.getByRole("button", { name: "Debugger" }));

    expect(screen.getByRole("dialog", { name: /choose workflow test source/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save and test/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /test draft snapshot/i })).toBeEnabled();
  });

  it("edits Transform OBJECT fields visually and preserves literal/expression choices", async () => {
    createVersion.mutateAsync.mockResolvedValue(version("version-2", 2, "DRAFT", []));
    render(<WorkflowEditor workflow={workflow()} onRefresh={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    await userEvent.selectOptions(screen.getByLabelText("Step type to add"), "transform");
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));

    const fields = () => screen.getByLabelText("Transform fields");
    expect(within(fields()).queryByRole("textbox", { name: /fields/i })).not.toBeInTheDocument();

    fireEvent.change(within(fields()).getByLabelText("Field name"), { target: { value: "value" } });
    await userEvent.selectOptions(within(fields()).getByLabelText("Field value type"), "literal");
    expect(within(fields()).getByLabelText("Field value type")).toHaveValue("literal");
    expect(within(fields()).getByLabelText("Field value")).toHaveValue("{{trigger.body}}");
    fireEvent.change(within(fields()).getByLabelText("Field value"), { target: { value: "123" } });

    await userEvent.selectOptions(screen.getByLabelText("Output type"), "NUMBER");
    await userEvent.click(within(fields()).getByRole("button", { name: /add field/i }));
    await waitFor(() => expect(within(fields()).getAllByLabelText("Field name")).toHaveLength(2));
    fireEvent.change(within(fields()).getAllByLabelText("Field name")[1], { target: { value: "value" } });
    expect(within(fields()).getByText("Field names must be unique.")).toBeInTheDocument();
    fireEvent.change(within(fields()).getAllByLabelText("Field name")[1], { target: { value: "constructor" } });
    expect(within(fields()).getByText("This field name is not allowed.")).toBeInTheDocument();
    await userEvent.click(within(fields()).getAllByRole("button", { name: /remove/i })[1]);

    await waitFor(() => expect(within(fields()).getAllByLabelText("Field name")).toHaveLength(1));
    expect(JSON.parse((document.querySelector('input[name="steps.1.config.fields"]') as HTMLInputElement).value)).toEqual({ value: 123 });
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
