import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JsonViewer } from "./json-viewer";

describe("JsonViewer", () => {
  it("redacts sensitive keys", () => {
    render(<JsonViewer value={{ authorization: "secret", accessToken: "access-secret", nested: { token: "abc", apiKey: "key", ok: true } }} />);

    expect(screen.getByText((content) => content.includes("[redacted]"))).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.queryByText("access-secret")).not.toBeInTheDocument();
    expect(screen.queryByText("abc")).not.toBeInTheDocument();
    expect(screen.queryByText("key")).not.toBeInTheDocument();
  });

  it("truncates very large content", () => {
    render(<JsonViewer value={{ data: "x".repeat(110_000) }} />);

    expect(screen.getByText(/Content was truncated/)).toBeInTheDocument();
  });
});
