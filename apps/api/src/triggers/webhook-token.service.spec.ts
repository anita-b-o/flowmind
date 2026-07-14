import { WebhookTokenService } from "./webhook-token.service";

describe("WebhookTokenService", () => {
  const previousPepper = process.env.WEBHOOK_TOKEN_PEPPER;

  beforeEach(() => {
    process.env.WEBHOOK_TOKEN_PEPPER = "unit-test-webhook-pepper";
  });

  afterAll(() => {
    process.env.WEBHOOK_TOKEN_PEPPER = previousPepper;
  });

  it("generates, hashes and verifies high entropy tokens", () => {
    const service = new WebhookTokenService();
    const token = service.generateToken();
    const hash = service.hashToken(token);

    expect(token).toHaveLength(43);
    expect(hash).not.toContain(token);
    expect(service.verifyToken(token, hash)).toBe(true);
    expect(service.verifyToken("wrong-token", hash)).toBe(false);
  });

  it("invalidates the old token when a new rotated hash is used", () => {
    const service = new WebhookTokenService();
    const oldToken = service.generateToken();
    const newToken = service.generateToken();
    const rotatedHash = service.hashToken(newToken);

    expect(service.verifyToken(oldToken, rotatedHash)).toBe(false);
    expect(service.verifyToken(newToken, rotatedHash)).toBe(true);
  });
});
