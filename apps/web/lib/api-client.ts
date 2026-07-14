import { clearAuthSession, getAccessToken, getActiveOrganizationId, refreshAuthSession, setAccessToken } from "../features/auth/session-store";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const NO_AUTO_REFRESH = new Set(["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"]);
let refreshPromise: Promise<string | undefined> | undefined;

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
  query?: Record<string, string | number | undefined>,
  retried = false
): Promise<T> {
  const response = await fetch(buildUrl(path, query), {
    ...init,
    credentials: "include",
    headers: requestHeaders(init.headers)
  });
  const payload = await readPayload(response);
  if (response.ok) {
    return payload as T;
  }

  if (response.status === 401 && !retried && !NO_AUTO_REFRESH.has(path)) {
    const refreshedToken = await singleFlightRefresh();
    if (refreshedToken) {
      return request<T>(path, init, query, true);
    }
  }

  throw new ApiError(response.status, errorMessage(response.status, payload), payload);
}

function requestHeaders(headers: HeadersInit | undefined) {
  const accessToken = getAccessToken();
  const organizationId = getActiveOrganizationId();
  return {
    "content-type": "application/json",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(organizationId ? { "x-organization-id": organizationId } : {}),
    ...(headers ?? {})
  };
}

async function singleFlightRefresh() {
  if (!refreshPromise) {
    refreshPromise = refreshAuthSession()
      .then((token) => {
        setAccessToken(token);
        if (!token) {
          clearAuthSession();
        }
        return token;
      })
      .catch((error) => {
        clearAuthSession();
        throw error;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  }
  return refreshPromise;
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

export async function authFetch<T = any>(path: string, init: RequestInit = {}) {
  const response = await fetch(buildUrl(path), {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(response.status, payload), payload);
  }
  return payload as T;
}
