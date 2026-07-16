import { createCipheriv, randomBytes } from "node:crypto";
import { ConnectionResolver } from "./connection-resolver";
import { ConnectionCryptoService } from "./connection-crypto.service";

describe("ConnectionResolver", () => {
  const previous = process.env.CONNECTION_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CONNECTION_ENCRYPTION_KEY = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  });

  afterEach(() => {
    process.env.CONNECTION_ENCRYPTION_KEY = previous;
  });

  it("resolves and decrypts an active HTTP API key connection", async () => {
    const prisma = prismaMock({
      connection: { id: "conn-1", type: "http_api_key", status: "ACTIVE", configJson: { authLocation: "HEADER", authName: "Authorization" } },
      secret: { encryptedValue: encrypt("Bearer test") }
    });
    const resolver = new ConnectionResolver(prisma as any, new ConnectionCryptoService());

    const result = await resolver.resolveHttpApiKey("org-1", "conn-1");

    expect(result.secretValue).toBe("Bearer test");
    expect(result.authName).toBe("Authorization");
  });

  it("rejects revoked connections without decrypting", async () => {
    const prisma = prismaMock({
      connection: { id: "conn-1", type: "smtp", status: "REVOKED", configJson: {} },
      secret: { encryptedValue: encrypt("password") }
    });
    const resolver = new ConnectionResolver(prisma as any, new ConnectionCryptoService());

    await expect(resolver.resolveSmtp("org-1", "conn-1")).rejects.toThrow("CONNECTION_REVOKED");
  });
});

function prismaMock(records: { connection: unknown; secret: unknown }) {
  return {
    connection: { findFirst: jest.fn(async () => records.connection) },
    secret: { findFirst: jest.fn(async () => records.secret) }
  };
}

function encrypt(plaintext: string) {
  const key = Buffer.alloc(32, 0);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyId: "primary"
  });
}
