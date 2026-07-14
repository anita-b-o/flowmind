import { createHash } from "node:crypto";
import type { Request } from "express";

export function sessionMetadata(request: Request) {
  return {
    userAgent: request.headers["user-agent"]?.slice(0, 512),
    ipHash: hashIp(normalizedIp(request))
  };
}

function normalizedIp(request: Request) {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0] || request.ip || request.socket.remoteAddress || "";
  return raw.trim().replace(/^::ffff:/, "");
}

function hashIp(ip: string) {
  if (!ip) {
    return undefined;
  }
  const pepper = process.env.SESSION_IP_HASH_PEPPER ?? "change-me-session-ip-pepper";
  return createHash("sha256").update(`${pepper}:${ip}`).digest("hex");
}
