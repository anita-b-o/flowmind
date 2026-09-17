import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowPalette } from "./workflow-palette";

describe("WorkflowPalette", () => {
  it("offers graph-native IF and Switch but not legacy Conditional", () => {
    render(<WorkflowPalette disabled={false} onAdd={vi.fn()} />);

    expect(screen.getByRole("button", { name: /if route true and false branches/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch route cases plus default/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /conditional/i })).not.toBeInTheDocument();
  });
});
