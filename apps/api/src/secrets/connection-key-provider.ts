import { Injectable } from "@nestjs/common";

export type ConnectionEncryptionKey = {
  keyId: string;
  version: number;
  key: Buffer;
};

@Injectable()
export class ConnectionKeyProvider {
  private readonly active: ConnectionEncryptionKey;

  constructor() {
    this.active = {
      keyId: process.env.CONNECTION_ENCRYPTION_KEY_ID ?? "primary",
      version: Number(process.env.CONNECTION_ENCRYPTION_VERSION ?? 1),
      key: decodeConnectionEncryptionKey(process.env.CONNECTION_ENCRYPTION_KEY)
    };
  }

  activeKey() {
    return this.active;
  }

  keyFor(keyId?: string | null) {
    if (!keyId || keyId === this.active.keyId) {
      return this.active;
    }
    throw new Error("Connection encryption key is not available");
  }
}

export function decodeConnectionEncryptionKey(value: string | undefined) {
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
