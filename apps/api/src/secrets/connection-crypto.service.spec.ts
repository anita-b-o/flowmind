import { ConnectionCryptoService } from "./connection-crypto.service";
import { ConnectionKeyProvider } from "./connection-key-provider";

describe("ConnectionCryptoService", () => {
  const previous = process.env.CONNECTION_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.CONNECTION_ENCRYPTION_KEY = previous;
  });

  function service(key = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") {
    process.env.CONNECTION_ENCRYPTION_KEY = key;
    return new ConnectionCryptoService(new ConnectionKeyProvider());
  }

  it("roundtrips plaintext", () => {
    const crypto = service();
    const encrypted = crypto.encrypt("secret-value");
    expect(crypto.decrypt(encrypted.encryptedValue)).toBe("secret-value");
  });

  it("uses a random IV for each encryption", () => {
    const crypto = service();
    expect(crypto.encrypt("same").encryptedValue).not.toBe(crypto.encrypt("same").encryptedValue);
  });

  it("fails when auth tag is invalid", () => {
    const crypto = service();
    const payload = JSON.parse(crypto.encrypt("secret").encryptedValue);
    payload.authTag = Buffer.alloc(16).toString("base64");
    expect(() => crypto.decrypt(JSON.stringify(payload))).toThrow("Connection secret could not be decrypted");
  });

  it("fails with the wrong key", () => {
    const encrypted = service("base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").encrypt("secret");
    const other = service("base64:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=");
    expect(() => other.decrypt(encrypted.encryptedValue)).toThrow("Connection secret could not be decrypted");
  });

  it("fails for corrupt payloads without leaking plaintext", () => {
    const crypto = service();
    expect(() => crypto.decrypt("{bad")).toThrow("Connection secret could not be decrypted");
    expect(() => crypto.decrypt("{bad")).not.toThrow("secret-value");
  });

  it("rejects malformed keys", () => {
    process.env.CONNECTION_ENCRYPTION_KEY = "base64:bad";
    expect(() => new ConnectionKeyProvider()).toThrow("CONNECTION_ENCRYPTION_KEY must decode to 32 bytes");
  });
});
