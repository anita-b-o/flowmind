import { createDecipheriv } from "node:crypto";
import { Injectable } from "@nestjs/common";

const ALGORITHM = "aes-256-gcm";

type EncryptedPayload = {
  v: number;
  alg: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  authTag: string;
  keyId: string;
};

@Injectable()
export class ConnectionCryptoService {
  private readonly key = decodeConnectionEncryptionKey(process.env.CONNECTION_ENCRYPTION_KEY);
  private readonly keyId = process.env.CONNECTION_ENCRYPTION_KEY_ID ?? "primary";

  decrypt(encryptedValue: string) {
    try {
      const payload = JSON.parse(encryptedValue) as EncryptedPayload;
      if (payload.v !== 1 || payload.alg !== "AES-256-GCM" || payload.keyId !== this.keyId) {
        throw new Error("Unsupported connection secret payload");
      }
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(payload.iv, "base64"));
      decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Connection secret could not be decrypted");
    }
  }
}

function decodeConnectionEncryptionKey(value: string | undefined) {
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CONNECTION_ENCRYPTION_KEY is required");
    }
    return Buffer.alloc(32, 0);
  }
  const separator = value.indexOf(":");
  const prefix = separator >= 0 ? value.slice(0, separator) : "base64";
  const encoded = separator >= 0 ? value.slice(separator + 1) : value;
  const buffer = prefix === "base64" ? Buffer.from(encoded, "base64") : prefix === "hex" ? Buffer.from(encoded, "hex") : undefined;
  if (!buffer || buffer.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return buffer;
}
