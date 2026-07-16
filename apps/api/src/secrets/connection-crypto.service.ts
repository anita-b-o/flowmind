import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConnectionKeyProvider } from "./connection-key-provider";

const ALGORITHM = "aes-256-gcm";
const PAYLOAD_VERSION = 1;
const IV_BYTES = 12;

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
  constructor(private readonly keys: ConnectionKeyProvider) {}

  encrypt(plaintext: string) {
    const active = this.keys.activeKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, active.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const payload: EncryptedPayload = {
      v: PAYLOAD_VERSION,
      alg: "AES-256-GCM",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyId: active.keyId
    };
    return {
      encryptedValue: JSON.stringify(payload),
      encryptionVersion: active.version,
      keyId: active.keyId
    };
  }

  decrypt(encryptedValue: string) {
    try {
      const payload = JSON.parse(encryptedValue) as EncryptedPayload;
      if (payload.v !== PAYLOAD_VERSION || payload.alg !== "AES-256-GCM") {
        throw new Error("Unsupported connection secret payload");
      }
      const key = this.keys.keyFor(payload.keyId);
      const decipher = createDecipheriv(ALGORITHM, key.key, Buffer.from(payload.iv, "base64"));
      decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Connection secret could not be decrypted");
    }
  }
}
