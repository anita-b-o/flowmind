import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  compareTableInventory,
  deriveTablesFromMigrationSql,
  summarizeMigrationHistory,
  validateDirectNeonUrl,
} from "./post-migrate-checker-lib.mjs";

class SafeFailure extends Error {}

try {
  await main();
} catch (error) {
  if (error instanceof SafeFailure) {
    process.stderr.write(`post-migrate-checker: ${error.message}\n`);
  } else {
    process.stderr.write(
      "post-migrate-checker: verification failed; connection details were redacted\n",
    );
  }
  process.exitCode = 1;
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  try {
    validateDirectNeonUrl(databaseUrl);
  } catch (error) {
    fail(error.message);
  }

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = join(
    scriptDirectory,
    "..",
    "prisma",
    "migrations",
  );
  const migrationNames = (
    await readdir(migrationsDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sqlDocuments = [];
  const localMigrations = [];
  for (const name of migrationNames) {
    const sql = await readFile(
      join(migrationsDirectory, name, "migration.sql"),
    );
    sqlDocuments.push(sql.toString("utf8"));
    localMigrations.push({
      name,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  const migrationTables = deriveTablesFromMigrationSql(sqlDocuments);
  const schemaTables = Prisma.dmmf.datamodel.models
    .map((model) => model.dbName ?? model.name)
    .sort();
  const localInventory = compareTableInventory(schemaTables, migrationTables);
  if (localInventory.missing.length || localInventory.unexpected.length) {
    fail("Prisma schema and local migration table inventories differ");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  try {
    await prisma.$connect();
    const versionRows = await prisma.$queryRaw`
      SELECT version() AS "versionText"
    `;
    const serverVersionRows = await prisma.$queryRaw`
      SHOW server_version
    `;
    const identityRows = await prisma.$queryRaw`
      SELECT current_database() AS "databaseName"
    `;
    const versionText = versionRows[0]?.versionText;
    const serverVersion = Object.values(serverVersionRows[0] ?? {})[0];
    const databaseName = identityRows[0]?.databaseName;
    if (
      typeof versionText !== "string" ||
      !versionText.startsWith("PostgreSQL 16") ||
      typeof serverVersion !== "string" ||
      !/^16(?:\.|$)/.test(serverVersion)
    ) {
      fail("expected PostgreSQL 16");
    }
    if (databaseName !== "neondb") fail("expected database neondb");

    const migrationTableName = "_prisma_migrations";
    const migrationTableRows = await prisma.$queryRaw(
      Prisma.sql`
        SELECT to_regclass(${migrationTableName})::text AS "tableName"
      `,
    );
    if (
      String(migrationTableRows[0]?.tableName ?? "").replaceAll('"', "") !==
      migrationTableName
    ) {
      fail("_prisma_migrations is absent");
    }

    const historyRows = await prisma.$queryRaw`
      SELECT migration_name, checksum, finished_at, rolled_back_at, logs
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `;
    const history = summarizeMigrationHistory(localMigrations, historyRows);
    if (
      history.rows !== localMigrations.length ||
      history.appliedNames.length !== localMigrations.length ||
      history.pendingNames.length !== 0 ||
      history.failedNames.length !== 0 ||
      history.checksumMismatchNames.length !== 0 ||
      history.duplicateNames.length !== 0 ||
      history.unexpectedNames.length !== 0 ||
      !history.exactPrefix
    ) {
      fail("migration history is not complete and consistent");
    }

    const tableRows = await prisma.$queryRaw`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const actualTables = tableRows.map((row) => row.tablename);
    const expectedTables = [...migrationTables, migrationTableName].sort();
    const remoteInventory = compareTableInventory(expectedTables, actualTables);
    if (remoteInventory.missing.length || remoteInventory.unexpected.length) {
      fail("PostgreSQL table inventory differs from local migrations");
    }

    process.stdout.write(
      `${JSON.stringify({
        prismaConnection: true,
        postgresVersion: serverVersion,
        database: databaseName,
        migrationTable: true,
        migrations: {
          local: localMigrations.length,
          rows: history.rows,
          applied: history.appliedNames.length,
          pending: history.pendingNames.length,
          failed: history.failedNames.length,
          checksumMismatches: history.checksumMismatchNames.length,
        },
        tables: {
          application: migrationTables.length,
          total: actualTables.length,
          names: actualTables,
        },
      })}\n`,
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  throw new SafeFailure(message);
}
