import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

class SafeFailure extends Error {}

try {
  await main();
} catch (error) {
  if (error instanceof SafeFailure) {
    process.stderr.write(`migration-history: ${error.message}\n`);
  } else {
    process.stderr.write(
      "migration-history: database inspection failed; connection details were redacted\n",
    );
  }
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const modes = args.filter((argument) =>
    ["--allow-pending", "--expect-complete"].includes(argument),
  );
  const mode = modes[0];
  const expectPooler = args.includes("--expect-pooler");
  if (
    modes.length !== 1 ||
    args.some(
      (argument) =>
        !["--allow-pending", "--expect-complete", "--expect-pooler"].includes(
          argument,
        ),
    )
  ) {
    fail(
      "usage: check-migration-history.mjs [--allow-pending|--expect-complete] [--expect-pooler]",
    );
  }

  const databaseUrl = required("DATABASE_URL");
  const neonConnection = validateNeonUrl(databaseUrl, expectPooler);
  const { PrismaClient } = await import("@prisma/client");

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = join(
    scriptDirectory,
    "..",
    "prisma",
    "migrations",
  );
  const localNames = (
    await readdir(migrationsDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (localNames.length !== 26) {
    fail(`expected 26 local migrations, found ${localNames.length}`);
  }

  const localChecksums = new Map();
  for (const name of localNames) {
    const sql = await readFile(
      join(migrationsDirectory, name, "migration.sql"),
    );
    localChecksums.set(name, createHash("sha256").update(sql).digest("hex"));
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    await verifyNeonTlsConnection(prisma, neonConnection);

    const tableResult = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('"_prisma_migrations"')::text AS "tableName"`,
    );
    const tableExists = tableResult[0]?.tableName !== null;

    if (!tableExists) {
      if (mode === "--expect-complete") {
        fail("Prisma migration history is absent after deployment");
      }
      process.stdout.write(
        "Prisma history preflight: empty database, 26 pending\n",
      );
      return;
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT migration_name, checksum, finished_at, rolled_back_at, logs
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `);

    const seen = new Set();
    for (const row of rows) {
      if (!localChecksums.has(row.migration_name)) {
        fail(`unexpected migration in database: ${row.migration_name}`);
      }
      if (seen.has(row.migration_name)) {
        fail(`duplicate migration history row: ${row.migration_name}`);
      }
      if (row.finished_at === null || row.rolled_back_at !== null || row.logs) {
        fail(
          `failed, partial, or rolled-back migration: ${row.migration_name}`,
        );
      }
      if (row.checksum !== localChecksums.get(row.migration_name)) {
        fail(`migration checksum mismatch: ${row.migration_name}`);
      }
      seen.add(row.migration_name);
    }

    const appliedNames = [...seen];
    const expectedPrefix = localNames.slice(0, appliedNames.length);
    if (appliedNames.some((name, index) => name !== expectedPrefix[index])) {
      fail(
        "database migration history is not an exact prefix of local history",
      );
    }

    const pending = localNames.length - appliedNames.length;
    if (mode === "--expect-complete" && pending !== 0) {
      fail(`expected complete migration history, found ${pending} pending`);
    }
    process.stdout.write(
      `Prisma history verified: ${appliedNames.length} applied, ${pending} pending\n`,
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

function validateNeonUrl(value, expectPooler) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("DATABASE_URL is not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("DATABASE_URL must use PostgreSQL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.startsWith("ep-") || !hostname.endsWith(".neon.tech")) {
    fail("DATABASE_URL must use the expected Neon endpoint hostname");
  }
  const pooled = hostname.includes("-pooler.");
  if (expectPooler && !pooled) {
    fail("DATABASE_URL must use the pooled Neon endpoint");
  }
  if (!expectPooler && pooled) {
    fail("DATABASE_URL must use the direct Neon endpoint, not the pooler");
  }

  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "require") {
    fail("DATABASE_URL must include sslmode=require");
  }

  const channelBindings = parsed.searchParams.getAll("channel_binding");
  if (
    channelBindings.length > 0 &&
    (channelBindings.length !== 1 || channelBindings[0] !== "require")
  ) {
    fail("DATABASE_URL channel_binding must be require when supplied by Neon");
  }

  return {
    channelBindingRequired: channelBindings.length === 1,
    endpoint: expectPooler ? "pooled" : "direct",
  };
}

async function verifyNeonTlsConnection(prisma, connection) {
  const versionRows = await prisma.$queryRawUnsafe(
    `SELECT version() AS "versionText"`,
  );
  const serverVersionRows = await prisma.$queryRawUnsafe(`SHOW server_version`);
  const identityRows = await prisma.$queryRawUnsafe(`
    SELECT
      current_database() AS "databaseName",
      current_user AS "userName"
  `);

  const versionText = versionRows[0]?.versionText;
  const serverVersion = Object.values(serverVersionRows[0] ?? {})[0];
  const identity = identityRows[0];
  if (
    typeof versionText !== "string" ||
    !versionText.startsWith("PostgreSQL 16") ||
    typeof serverVersion !== "string" ||
    !/^16(?:\.|$)/.test(serverVersion)
  ) {
    fail("Neon must run PostgreSQL 16");
  }
  if (
    typeof identity?.databaseName !== "string" ||
    identity.databaseName.length === 0 ||
    typeof identity?.userName !== "string" ||
    identity.userName.length === 0
  ) {
    fail("Neon connection identity query returned an invalid result");
  }

  const channelBinding = connection.channelBindingRequired
    ? "require"
    : "not supplied";
  process.stdout.write(
    `Neon TLS preflight verified: PostgreSQL ${serverVersion}; ${connection.endpoint} endpoint; sslmode=require; channel_binding=${channelBinding}; connection queries passed\n`,
  );
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  throw new SafeFailure(message);
}
