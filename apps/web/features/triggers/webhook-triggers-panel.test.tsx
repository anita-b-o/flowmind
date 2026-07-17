import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookTriggersPanel } from "./webhook-triggers-panel";

const create = { mutateAsync: vi.fn(), isPending: false, error: null };
const rotate = { mutateAsync: vi.fn(), isPending: false, error: null };
const enable = { mutateAsync: vi.fn(), isPending: false };
const disable = { mutateAsync: vi.fn(), isPending: false };
const remove = { mutateAsync: vi.fn(), isPending: false };
const update = { mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() };

vi.mock("./hooks", () => ({
  useTriggers: () => ({
    data: [
      {
        id: "trigger-1",
        type: "webhook",
        workflowId: "workflow-1",
        enabled: true,
        method: "POST",
        httpMethod: "POST",
        tokenPreview: "abcd...wxyz",
        maskedWebhookUrl: "https://api.test/webhooks/trigger-1/abcd...wxyz",
        tokenAvailable: false,
        createdAt: "2026-07-17T00:00:00.000Z",
        rotatedAt: null,
        lastReceivedAt: null,
        lastExecutionId: "execution-1",
        config: {
          name: "Inbound leads",
          idempotencyHeader: "Idempotency-Key",
          payloadLimits: { maxBytes: 1048576, maxDepth: 8, maxKeys: 1000, maxArrayLength: 200, maxStringLength: 16384, requireBody: true },
          signature: {
            enabled: false,
            algorithm: "HMAC-SHA256",
            signatureHeader: "x-flowmind-signature",
            timestampHeader: "x-flowmind-timestamp",
            nonceHeader: "x-flowmind-nonce",
            toleranceSeconds: 300,
            secretAvailable: false
          }
        }
      }
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn()
  }),
  useCreateWebhookTrigger: () => create,
  useRotateWebhookTrigger: () => rotate,
  useEnableWebhookTrigger: () => enable,
  useDisableWebhookTrigger: () => disable,
  useDeleteWebhookTrigger: () => remove,
  useUpdateWebhookTrigger: () => update
}));

describe("WebhookTriggersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    create.mutateAsync.mockResolvedValue({ token: "new-token", webhookUrl: "https://api.test/webhooks/trigger-2/new-token" });
    rotate.mutateAsync.mockResolvedValue({ token: "rotated-token", webhookUrl: "https://api.test/webhooks/trigger-1/rotated-token" });
  });

  it("shows trigger details, copies the masked URL, and creates one-time secrets", async () => {
    const onSecret = vi.fn();
    render(<WebhookTriggersPanel workflowId="workflow-1" canManage onSecret={onSecret} />);

    expect(screen.getByText("Inbound leads")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://api.test/webhooks/trigger-1/abcd...wxyz")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /copy preview/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://api.test/webhooks/trigger-1/abcd...wxyz");

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(onSecret).toHaveBeenCalledWith({ token: "new-token", webhookUrl: "https://api.test/webhooks/trigger-2/new-token", signatureSecret: undefined });
  });

  it("confirms rotation and preserves token as one-time UI state only", async () => {
    const onSecret = vi.fn();
    render(<WebhookTriggersPanel workflowId="workflow-1" canManage onSecret={onSecret} />);

    await userEvent.click(screen.getByRole("button", { name: /^rotate$/i }));
    await userEvent.click(screen.getByRole("button", { name: /rotate token/i }));

    expect(rotate.mutateAsync).toHaveBeenCalledWith("trigger-1");
    expect(onSecret).toHaveBeenCalledWith({ token: "rotated-token", webhookUrl: "https://api.test/webhooks/trigger-1/rotated-token", signatureSecret: undefined });
  });
});
