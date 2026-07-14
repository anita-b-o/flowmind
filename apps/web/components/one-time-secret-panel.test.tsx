import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OneTimeSecretPanel } from "./one-time-secret-panel";

describe("OneTimeSecretPanel", () => {
  it("shows the token once and clears when closed by parent", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<OneTimeSecretPanel secret={{ token: "plain-token", webhookUrl: "https://api.test/webhooks/1/plain-token" }} onClose={onClose} />);

    expect(screen.getByDisplayValue("plain-token")).toBeInTheDocument();
    expect(localStorage.getItem("plain-token")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();

    rerender(<OneTimeSecretPanel secret={null} onClose={onClose} />);
    expect(screen.queryByDisplayValue("plain-token")).not.toBeInTheDocument();
  });
});
