import { AuthRateLimitService } from "./auth-rate-limit.service";

describe("AuthRateLimitService", () => {
  const previous = { ...process.env };
  afterEach(() => { process.env = { ...previous }; });

  it("uses bounded account/IP keys and returns a homogeneous 429", async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_RATE_LIMIT_TEST_ENABLED = "true";
    process.env.AUTH_RATE_LIMIT_MAX_PER_IP = "1";
    process.env.AUTH_RATE_LIMIT_MAX_PER_ACCOUNT = "1";
    const evalMock = jest.fn().mockResolvedValueOnce([1, 60]).mockResolvedValueOnce([1, 60]).mockResolvedValueOnce([2, 59]);
    const service = new AuthRateLimitService({ eval: evalMock, disconnect: jest.fn() } as any);
    await expect(service.assertAllowed("login", "ip-hash", "User@Example.com")).resolves.toBeUndefined();
    await expect(service.assertAllowed("login", "ip-hash", "User@Example.com")).rejects.toMatchObject({ status: 429 });
    expect(evalMock.mock.calls.flat().join(" ")).not.toContain("User@Example.com");
  });

  it("fails closed when Redis is unavailable", async () => {
    process.env.NODE_ENV = "production";
    const service = new AuthRateLimitService({ eval: jest.fn().mockRejectedValue(new Error("down")), disconnect: jest.fn() } as any);
    await expect(service.assertAllowed("refresh", "ip-hash")).rejects.toMatchObject({ status: 503 });
  });
});
