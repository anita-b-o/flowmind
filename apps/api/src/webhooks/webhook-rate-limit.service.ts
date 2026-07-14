import { HttpException, HttpStatus, Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class WebhookRateLimitService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true
  });

  async assertAllowed(key: string, max = this.maxRequests(), windowSeconds = this.windowSeconds()) {
    if (process.env.WEBHOOK_RATE_LIMIT_DISABLED === "true") {
      return;
    }
    if (this.redis.status === "wait" || this.redis.status === "end") {
      await this.redis.connect();
    }
    const redisKey = `webhook-rate:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }
    if (count > max) {
      throw new HttpException("Webhook rate limit exceeded", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async onModuleDestroy() {
    try {
      if (this.redis.status === "ready" || this.redis.status === "connect") {
        await this.redis.quit();
      } else {
        this.redis.disconnect();
      }
    } catch {
      this.redis.disconnect();
    }
  }

  private maxRequests() {
    return Number(process.env.WEBHOOK_RATE_LIMIT_MAX ?? 60);
  }

  private windowSeconds() {
    return Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS ?? 60);
  }

  burstMax() {
    return Number(process.env.WEBHOOK_BURST_LIMIT_MAX ?? 10);
  }
}
