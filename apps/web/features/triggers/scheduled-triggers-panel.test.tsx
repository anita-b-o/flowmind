import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledTriggersPanel } from "./scheduled-triggers-panel";

const create = { mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() };
const update = { mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() };
const enable = { mutateAsync: vi.fn(), isPending: false };
const disable = { mutateAsync: vi.fn(), isPending: false };
const pause = { mutateAsync: vi.fn(), isPending: false };
const resume = { mutateAsync: vi.fn(), isPending: false };
const remove = { mutateAsync: vi.fn(), isPending: false };
const preview = { mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn(), data: { nextRuns: ["2026-07-20T09:00:00.000Z"] } };

vi.mock("./hooks", () => ({
  useScheduledTriggers: () => ({
    data: [
      {
        id: "scheduled-1",
        type: "scheduled",
        workflowId: "workflow-1",
        enabled: true,
        paused: false,
        cron: "0 9 * * 1-5",
        timezone: "UTC",
        executionPolicy: "skip_if_running",
        metadata: {},
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
        lastRunAt: null,
        nextRunAt: "2026-07-20T09:00:00.000Z",
        lastExecutionId: "execution-1"
      }
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn()
  }),
  useCreateScheduledTrigger: () => create,
  useUpdateScheduledTrigger: () => update,
  useEnableScheduledTrigger: () => enable,
  useDisableScheduledTrigger: () => disable,
  usePauseScheduledTrigger: () => pause,
  useResumeScheduledTrigger: () => resume,
  useDeleteScheduledTrigger: () => remove,
  usePreviewScheduledTrigger: () => preview
}));

describe("ScheduledTriggersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mutateAsync.mockResolvedValue({});
    update.mutateAsync.mockResolvedValue({});
    preview.mutateAsync.mockResolvedValue({ nextRuns: ["2026-07-20T09:00:00.000Z"] });
  });

  it("renders schedules, applies helper examples, previews and creates", async () => {
    render(<ScheduledTriggersPanel workflowId="workflow-1" canManage />);

    expect(screen.getByText("Scheduled trigger")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * 1-5")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /every hour/i }));
    expect(screen.getByLabelText("Scheduled trigger cron")).toHaveValue("0 * * * *");

    await userEvent.click(screen.getByRole("button", { name: /preview next runs/i }));
    expect(preview.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ cron: "0 * * * *" }));

    await userEvent.click(screen.getByRole("button", { name: /create schedule/i }));
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ cron: "0 * * * *" }));
  });

  it("pauses and confirms deletion", async () => {
    render(<ScheduledTriggersPanel workflowId="workflow-1" canManage />);

    await userEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    expect(pause.mutateAsync).toHaveBeenCalledWith("scheduled-1");

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /delete trigger/i }));
    expect(remove.mutateAsync).toHaveBeenCalledWith("scheduled-1");
  });
});
