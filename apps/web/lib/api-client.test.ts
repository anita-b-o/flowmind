import { publicApiUrl } from "./api-client";
import { afterEach, describe, expect, it } from "vitest";

describe("publicApiUrl", () => {
  afterEach(() => {
    delete window.__FLOWMIND_RUNTIME_CONFIG__;
  });

  it("prefers runtime configuration and removes trailing slashes", () => {
    window.__FLOWMIND_RUNTIME_CONFIG__ = {
      publicApiUrl: "https://api.staging.example.test/",
    };
    expect(publicApiUrl()).toBe("https://api.staging.example.test");
  });

  it("keeps the local fallback when runtime configuration is absent", () => {
    expect(publicApiUrl()).toMatch(/^http:\/\/localhost:3001$/);
  });
});
