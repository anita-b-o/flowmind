import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../lib/api-client";
import { AuthProvider } from "./auth-provider";
import { useAuth } from "./use-auth";
import { clearAuthSession, setAccessToken, setActiveOrganizationIdValue, setRefreshHandler } from "./session-store";

const user = { id: "user-1", email: "user@example.com", name: "User" };
const organizations = [{ id: "org-1", name: "Org", slug: "org", role: "owner" }];

describe("AuthProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    vi.restoreAllMocks();
  });

  it("does not keep access or refresh tokens in localStorage", async () => {
    localStorage.setItem("accessToken", "old");
    localStorage.setItem("refreshToken", "old-refresh");
    mockFetch([
      json(200, { accessToken: "access", user, defaultOrganizationId: "org-1" }),
      json(200, { user, organizations })
    ]);

    renderWithAuth(<Probe />);

    await screen.findByText("authenticated");
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(localStorage.getItem("refreshToken")).toBeNull();
  });

  it("initialization calls /auth/refresh and authenticates on success", async () => {
    const fetchMock = mockFetch([
      json(200, { accessToken: "access", user, defaultOrganizationId: "org-1" }),
      json(200, { user, organizations })
    ]);

    renderWithAuth(<Probe />);

    expect(await screen.findByText("authenticated")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain("/auth/refresh");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("failed refresh leaves the session anonymous", async () => {
    mockFetch([json(401, { message: "nope" })]);
    renderWithAuth(<Probe />);
    expect(await screen.findByText("anonymous")).toBeInTheDocument();
  });

  it("replaces an invalid persisted organization with an accessible one", async () => {
    localStorage.setItem("flowmind.activeOrganizationId", "missing");
    mockFetch([
      json(200, { accessToken: "access", user, defaultOrganizationId: "org-1" }),
      json(200, { user, organizations })
    ]);

    renderWithAuth(<Probe />);

    await screen.findByText("authenticated");
    expect(localStorage.getItem("flowmind.activeOrganizationId")).toBe("org-1");
  });

  it("logout clears state and TanStack Query cache even when the request fails", async () => {
    mockFetch([
      json(200, { accessToken: "access", user, defaultOrganizationId: "org-1" }),
      json(200, { user, organizations }),
      new Error("offline")
    ]);
    const client = new QueryClient();
    client.setQueryData(["cached"], { ok: true });

    renderWithAuth(<LogoutProbe />, client);
    await screen.findByText("authenticated");
    await userEvent.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    expect(client.getQueryData(["cached"])).toBeUndefined();
  });
});

describe("apiClient refresh behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    vi.restoreAllMocks();
  });

  it("coalesces multiple 401s into a single refresh", async () => {
    setAccessToken("expired");
    setActiveOrganizationIdValue("org-1");
    let refreshCount = 0;
    setRefreshHandler(async () => {
      refreshCount += 1;
      return "fresh";
    });
    mockFetch([json(401, {}), json(401, {}), json(200, { ok: 1 }), json(200, { ok: 2 })]);

    const [a, b] = await Promise.all([apiClient.get("/workflows"), apiClient.get("/executions")]);

    expect(a).toEqual({ ok: 1 });
    expect(b).toEqual({ ok: 2 });
    expect(refreshCount).toBe(1);
  });

  it("retries a request at most once", async () => {
    setAccessToken("expired");
    setRefreshHandler(async () => "fresh");
    mockFetch([json(401, {}), json(401, { message: "still unauthorized" })]);

    await expect(apiClient.get("/workflows")).rejects.toMatchObject({ status: 401 });
    expect((fetch as any).mock.calls).toHaveLength(2);
  });

  it("does not loop when refresh fails", async () => {
    setAccessToken("expired");
    let refreshCount = 0;
    setRefreshHandler(async () => {
      refreshCount += 1;
      throw new Error("refresh failed");
    });
    mockFetch([json(401, {})]);

    await expect(apiClient.get("/workflows")).rejects.toThrow("refresh failed");
    expect(refreshCount).toBe(1);
    expect((fetch as any).mock.calls).toHaveLength(1);
  });
});

function Probe() {
  const { status, user: currentUser } = useAuth();
  return (
    <div>
      <span>{status}</span>
      <span>{currentUser?.email}</span>
    </div>
  );
}

function LogoutProbe() {
  const { status, logout } = useAuth();
  const queryClient = useQueryClient();
  return (
    <div>
      <span>{status}</span>
      <span>{queryClient.getQueryData(["cached"]) ? "cached" : "empty"}</span>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

function renderWithAuth(children: ReactNode, client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function mockFetch(responses: Array<Response | Promise<Response> | Error>) {
  const fetchMock = vi.fn();
  responses.forEach((response) => {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
