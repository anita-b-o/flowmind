import { Injectable } from "@nestjs/common";
import { sanitizeForLog } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class DebugArtifactRecorder {
  constructor(private readonly prisma: PrismaService) {}

  async record(stepExecutionId: string, artifact: Record<string, unknown>) {
    await this.prisma.stepExecution.update({
      where: { id: stepExecutionId },
      data: { debugJson: toJson(sanitizeDebugArtifact(artifact)) }
    });
  }
}

const SENSITIVE_WORDS = /(^|[^a-z0-9])(authorization|cookie|token|secret|password|api[-_ ]?key)([^a-z0-9]|$)/i;

function sanitizeDebugArtifact(value: unknown): unknown {
  return sanitizeForLog(redact(value), { maxBytes: 16_384 });
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return SENSITIVE_WORDS.test(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redact(entry, seen)
    ])
  );
}

function isSensitiveKey(key: string) {
  return /^(authorization|cookie|setcookie|password|token|secret|apikey|xapikey|accesstoken|refreshtoken|encryptedvalue|ciphertext|authtag|iv|smtppassword)$/i.test(
    key.replace(/[-_]/g, "")
  );
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
