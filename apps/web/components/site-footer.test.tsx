import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./site-footer";

describe("SiteFooter", () => {
  it("credits Pampa Software with the expected external link", () => {
    render(<SiteFooter />);

    expect(screen.getByText("Developed by")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Pampa Software" });
    expect(link).toHaveAttribute("href", "https://pampasoftware.com.ar/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
