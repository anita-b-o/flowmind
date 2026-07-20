import { createHash } from "node:crypto";
import { HttpException, HttpStatus, Inject, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";

const INCREMENT_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;
export const AUTH_RATE_LIMIT_REDIS = Symbol("AUTH_RATE_LIMIT_REDIS");

@Injectable()
export class AuthRateLimitService implements OnModuleDestroy {
  private readonly redis: Pick<Redis, "eval" | "disconnect">;

  constructor(@Optional() @Inject(AUTH_RATE_LIMIT_REDIS) redis?: Pick<Redis, "eval" | "disconnect">) {
    this.redis = redis ?? new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000
    });
  }

  async assertAllowed(action: "register" | "login" | "refresh", ipHash?: string, account?: string) {
    if (process.env.NODE_ENV === "test" && process.env.AUTH_RATE_LIMIT_TEST_ENABLED !== "true") return;
    const windowSeconds = numberEnv("AUTH_RATE_LIMIT_WINDOW_SECONDS", 300);
    const checks: Array<[string, number]> = [];
    if (ipHash) checks.push([`auth-rate:${action}:ip:${ipHash}`, numberEnv("AUTH_RATE_LIMIT_MAX_PER_IP", 30)]);
    if (account) checks.push([`auth-rate:${action}:account:${hashAccount(account)}`, numberEnv("AUTH_RATE_LIMIT_MAX_PER_ACCOUNT", 10)]);
    try {
      for (const [key, limit] of checks) {
        const result = (await this.redis.eval(INCREMENT_WITH_TTL, 1, key, windowSeconds)) as [number, number];
        if (Number(result[0]) > limit) {
          throw new HttpException(
            { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "Too many authentication attempts", retryAfter: Math.max(1, Number(result[1])) },
            HttpStatus.TOO_MANY_REQUESTS
          );
        }
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException("Authentication rate limiting is unavailable");
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}

function hashAccount(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
