const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getStoredSession() {
  if (typeof window === "undefined") {
    return { accessToken: undefined, organizationId: undefined };
  }
  return {
    accessToken: localStorage.getItem("accessToken") ?? undefined,
    organizationId: localStorage.getItem("organizationId") ?? undefined
  };
}

export function clearStoredSession() {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem("accessToken");
  localStorage.removeItem("organizationId");
}

export function logoutLocal() {
  clearStoredSession();
  window.location.href = "/login";
}

function buildUrl(path: string, query?: Record<string, string | number | undefined>) {
  const url = new URL(`${apiUrl}${path}`);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function request<T = any>(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const { accessToken, organizationId } = getStoredSession();
  const response = await fetch(buildUrl(path, query), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(organizationId ? { "x-organization-id": organizationId } : {}),
      ...(init.headers ?? {})
    }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    if (response.status === 401) {
      clearStoredSession();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    throw new ApiError(response.status, errorMessage(response.status, payload), payload);
  }
  return payload as T;
}

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(status: number, payload: unknown) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message: unknown }).message;
    return Array.isArray(message) ? message.join(", ") : String(message);
  }
  const byStatus: Record<number, string> = {
    403: "You do not have permission to perform this action.",
    404: "The requested resource was not found.",
    409: "The request conflicts with the current state.",
    413: "The payload is too large.",
    429: "Too many requests. Please try again shortly."
  };
  return byStatus[status] ?? (status >= 500 ? "The server could not complete the request." : `Request failed with ${status}`);
}

export const apiClient = {
  get: <T = any>(path: string, query?: Record<string, string | number | undefined>) => request<T>(path, {}, query),
  post: <T = any>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T = any>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T = any>(path: string) => request<T>(path, { method: "DELETE" })
};
