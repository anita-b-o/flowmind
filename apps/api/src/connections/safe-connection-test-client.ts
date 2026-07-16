import { lookup } from "node:dns/promises";
import net from "node:net";
import { Injectable } from "@nestjs/common";

@Injectable()
export class SafeConnectionTestClient {
  async request(input: { url: string; method?: string; headers?: Record<string, string>; timeoutMs?: number }) {
    const url = new URL(input.url);
    await assertSafeUrl(url);
    const started = Date.now();
    const response = await fetch(url.toString(), {
      method: input.method ?? "GET",
      headers: input.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000)
    });
    return { status: response.status, ok: response.ok, durationMs: Date.now() - started };
  }
}

async function assertSafeUrl(url: URL) {
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
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((address) => isBlockedIp(address.address))) {
    throw new Error("Private, reserved or metadata IP is not allowed");
  }
}

function isBlockedIp(input: string) {
  const ip = input.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (ip === "169.254.169.254") return true;
  if (net.isIP(ip) === 4) return isBlockedIpv4(ip);
  if (net.isIP(ip) === 6) return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80") || ip.startsWith("ff");
  return true;
}

function isBlockedIpv4(ip: string) {
  const blocks: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ];
  const value = ipv4ToInt(ip);
  return blocks.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}
