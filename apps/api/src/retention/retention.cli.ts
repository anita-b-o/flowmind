import { PrismaClient } from "@prisma/client";
import { RetentionService } from "./retention.service";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const execute = args.has("execute");
  if (execute === args.has("dry-run")) throw new Error("Specify exactly one of --dry-run or --execute");
  const organizationId = required(args, "organization-id");
  const payloadCutoff = new Date(required(args, "payload-cutoff"));
  const metadataCutoff = new Date(required(args, "metadata-cutoff"));
  const batchSize = Number(args.get("batch-size") ?? 100);
  const prisma = new PrismaClient();
  try {
    const report = await new RetentionService(prisma).run({ organizationId, payloadCutoff, metadataCutoff, batchSize, execute });
    process.stdout.write(`${JSON.stringify({ event: "flowmind.retention.completed", outcome: "success", ...report })}\n`);
  } finally { await prisma.$disconnect(); }
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index++) {
    const arg = values[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (["dry-run", "execute"].includes(key)) parsed.set(key, "true");
    else parsed.set(key, values[++index] ?? "");
  }
  return parsed;
}
function required(args: Map<string, string>, key: string) { const value = args.get(key); if (!value) throw new Error(`--${key} is required`); return value; }

void main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: "flowmind.retention.completed", outcome: "failed", error: error instanceof Error ? error.message : "unknown" })}\n`); process.exitCode = 1; });
