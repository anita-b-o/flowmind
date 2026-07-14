import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class WebhookTokenService {
  generateToken() {
    return randomBytes(32).toString("base64url");
  }

  hashToken(token: string) {
    return createHash("sha256").update(`${token}:${this.pepper()}`).digest("hex");
  }

  verifyToken(token: string, hash: string) {
    const candidate = Buffer.from(this.hashToken(token), "hex");
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  buildWebhookUrl(workflowId: string, token: string) {
    const baseUrl = process.env.PUBLIC_API_URL ?? "http://localhost:3001";
    return `${baseUrl.replace(/\/$/, "")}/webhooks/${workflowId}/${token}`;
  }

  private pepper() {
    return process.env.WEBHOOK_TOKEN_PEPPER ?? "change-me-webhook-token-pepper";
  }
}
