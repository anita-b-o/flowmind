import net from "node:net";

const IPV4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

export function isBlockedIp(input: string) {
  const ip = normalizeIp(input);
  if (ip === "169.254.169.254") {
    return true;
  }
  if (net.isIP(ip) === 4) {
    return isBlockedIpv4(ip);
  }
  if (net.isIP(ip) === 6) {
    const mapped = ipv4Mapped(ip);
    if (mapped) {
      return isBlockedIpv4(mapped);
    }
    return isBlockedIpv6(ip);
  }
  return true;
}

export function normalizeIp(input: string) {
  return input.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isBlockedIpv4(ip: string) {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKS.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function isBlockedIpv6(ip: string) {
  const value = expandIpv6(ip);
  if (!value) {
    return true;
  }
  const first = value[0];
  return (
    value.every((part) => part === 0) ||
    ip === "::1" ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

function ipv4Mapped(ip: string) {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return lower.slice("::ffff:".length);
  }
  const expanded = expandIpv6(lower);
  if (!expanded) {
    return null;
  }
  if (expanded.slice(0, 5).every((part) => part === 0) && expanded[5] === 0xffff) {
    return `${expanded[6] >> 8}.${expanded[6] & 255}.${expanded[7] >> 8}.${expanded[7] & 255}`;
  }
  return null;
}

function expandIpv6(ip: string) {
  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    const prefix = ip.slice(0, lastColon);
    const ipv4 = ip.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) {
      return null;
    }
    const parts = ipv4.split(".").map(Number);
    ip = `${prefix}:${((parts[0] << 8) + parts[1]).toString(16)}:${((parts[2] << 8) + parts[3]).toString(16)}`;
  }
  const [leftRaw, rightRaw] = ip.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || ip.split("::").length > 2) {
    return null;
  }
  const parts = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (parts.length !== 8 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 0xffff)) {
    return null;
  }
  return parts;
}
