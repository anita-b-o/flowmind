import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequireAuth } from "./require-auth";

const useAuthMock = vi.fn();

vi.mock("./use-auth", () => ({
  useAuth: () => useAuthMock()
}));

describe("RequireAuth", () => {
  it("waits while auth is loading", () => {
    useAuthMock.mockReturnValue({ status: "loading" });
    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("redirects anonymous users", () => {
    useAuthMock.mockReturnValue({ status: "anonymous" });
    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("renders children when authenticated", () => {
    useAuthMock.mockReturnValue({ status: "authenticated" });
    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>
    );
    expect(screen.getByText("secret")).toBeInTheDocument();
  });
});
