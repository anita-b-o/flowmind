import type { CookieOptions, Request } from "express";

export const REFRESH_COOKIE_PATH = "/auth";

export function refreshCookieName() {
  return process.env.REFRESH_COOKIE_NAME ?? "refresh_token";
}

export function refreshTokenExpiresIn() {
  return process.env.JWT_REFRESH_EXPIRES_IN ?? "30d";
}

export function accessTokenExpiresIn() {
  return process.env.JWT_ACCESS_EXPIRES_IN ?? "15m";
}

export function refreshTokenMaxAgeMs() {
  return durationToMs(refreshTokenExpiresIn());
}

export function refreshCookieOptions(): CookieOptions {
  const sameSite = (process.env.REFRESH_COOKIE_SAME_SITE ?? "lax") as "lax" | "strict" | "none";
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || sameSite === "none",
    sameSite,
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTokenMaxAgeMs(),
    ...(process.env.REFRESH_COOKIE_DOMAIN ? { domain: process.env.REFRESH_COOKIE_DOMAIN } : {})
  };
}

export function clearRefreshCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  return options;
}

export function allowedOrigins() {
  return (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function shouldRequireOrigin() {
  if (process.env.AUTH_ORIGIN_REQUIRED !== undefined) {
    return process.env.AUTH_ORIGIN_REQUIRED === "true";
  }
  return process.env.NODE_ENV === "production";
}

export function assertAllowedOrigin(request: Request) {
  const origin = request.headers.origin;
  if (!origin) {
    if (shouldRequireOrigin()) {
      return false;
    }
    return true;
  }
  return allowedOrigins().includes(origin);
}

export function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function durationToMs(value: string) {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric * 1000;
    }
    return 30 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return amount * multipliers[unit];
}
