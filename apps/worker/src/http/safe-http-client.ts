import { Inject, Injectable, Optional } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isBlockedIp } from "./ip-range";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const BLOCKED_HEADER_NAMES = [/^host$/i, /^authorization$/i, /^cookie$/i, /^proxy-/i, /^x-forwarded-/i];
export const SAFE_HTTP_RESOLVER = Symbol("SAFE_HTTP_RESOLVER");
export const SAFE_HTTP_FETCHER = Symbol("SAFE_HTTP_FETCHER");

export interface SafeHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowedRestrictedHeaders?: string[];
}

export interface SafeHttpResponse {
  status: number;
  ok: boolean;
  body: unknown;
  headers: Record<string, string>;
}

@Injectable()
export class SafeHttpClient {
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly fetcher: typeof fetch;

  constructor(
    @Optional() @Inject(SAFE_HTTP_RESOLVER) resolveHost?: (hostname: string) => Promise<string[]>,
    @Optional() @Inject(SAFE_HTTP_FETCHER) fetcher?: typeof fetch
  ) {
    this.resolveHost = resolveHost ?? defaultResolve;
    this.fetcher = fetcher ?? fetch;
  }

  async request(input: SafeHttpRequest): Promise<SafeHttpResponse> {
    return this.requestWithRedirects(input, 0, new URL(input.url), sanitizeHeaders(input.headers ?? {}, input.allowedRestrictedHeaders ?? []));
  }

  private async requestWithRedirects(
    input: SafeHttpRequest,
    redirectCount: number,
    url: URL,
    headers: Record<string, string>
  ): Promise<SafeHttpResponse> {
    if (redirectCount > 3) {
      throw new Error("Too many redirects");
    }
    await this.assertSafeUrl(url);
    const method = (input.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`HTTP method ${method} is not allowed`);
    }
    const response = await this.fetcher(url.toString(), {
      method,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: input.body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.body),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
    });
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect response is missing Location header");
      }
      const nextUrl = new URL(location, url);
      const nextHeaders = nextUrl.host === url.host ? headers : {};
      return this.requestWithRedirects(input, redirectCount + 1, nextUrl, nextHeaders);
    }
    const maxResponseBytes = input.maxResponseBytes ?? 1_048_576;
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxResponseBytes) {
      throw new Error("HTTP response is too large");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) {
      throw new Error("HTTP response is too large");
    }
    return {
      status: response.status,
      ok: response.ok,
      body: safeJson(text),
      headers: Object.fromEntries(response.headers.entries())
    };
  }

  private async assertSafeUrl(url: URL) {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are allowed");
    }
    if (url.username || url.password) {
      throw new Error("URL credentials are not allowed");
    }
    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
    if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase() === "metadata.google.internal") {
      throw new Error("Internal host is not allowed");
    }
    const addresses = await this.resolveHost(hostname);
    if (!addresses.length || addresses.some((address) => isBlockedIp(address))) {
      throw new Error("Private, reserved or metadata IP is not allowed");
    }
  }
}

async function defaultResolve(hostname: string) {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((address) => address.address);
}

function sanitizeHeaders(headers: Record<string, string>, allowedRestrictedHeaders: string[]) {
  const entries = Object.entries(headers);
  if (entries.length > 32) {
    throw new Error("Too many headers");
  }
  const allowed = new Set(allowedRestrictedHeaders.map((header) => header.toLowerCase()));
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!allowed.has(key.toLowerCase()) && BLOCKED_HEADER_NAMES.some((pattern) => pattern.test(key))) {
        throw new Error(`Header ${key} is not allowed`);
      }
      if (value.length > 4096) {
        throw new Error(`Header ${key} is too large`);
      }
      return [key, value];
    })
  );
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
