export function validateDirectNeonUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.startsWith("ep-") || !hostname.endsWith(".neon.tech")) {
    throw new Error("DATABASE_URL must use a Neon endpoint");
  }
  if (hostname.includes("-pooler.")) {
    throw new Error("DATABASE_URL must use the direct Neon endpoint");
  }
  if (
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "require"
  ) {
    throw new Error("DATABASE_URL must include exactly one sslmode=require");
  }
  if (
    parsed.searchParams.getAll("channel_binding").length !== 1 ||
    parsed.searchParams.get("channel_binding") !== "require"
  ) {
    throw new Error(
      "DATABASE_URL must include exactly one channel_binding=require",
    );
  }
}

export function deriveTablesFromMigrationSql(sqlDocuments) {
  const tables = new Set();
  const operationPattern =
    /CREATE TABLE\s+"([^"]+)"|DROP TABLE(?:\s+IF EXISTS)?\s+"([^"]+)"|ALTER TABLE\s+"([^"]+)"\s+RENAME TO\s+"([^"]+)"/g;
  for (const sql of sqlDocuments) {
    for (const match of sql.matchAll(operationPattern)) {
      if (match[1]) {
        tables.add(match[1]);
      } else if (match[2]) {
        tables.delete(match[2]);
      } else {
        tables.delete(match[3]);
        tables.add(match[4]);
      }
    }
  }
  return [...tables].sort();
}

export function summarizeMigrationHistory(localMigrations, rows) {
  const localByName = new Map(
    localMigrations.map((migration) => [migration.name, migration]),
  );
  const seen = new Set();
  const duplicateNames = [];
  const unexpectedNames = [];
  const failedNames = [];
  const checksumMismatchNames = [];
  const appliedNames = [];

  for (const row of rows) {
    const name = row.migration_name;
    if (seen.has(name)) duplicateNames.push(name);
    seen.add(name);
    const local = localByName.get(name);
    if (!local) {
      unexpectedNames.push(name);
      continue;
    }
    if (row.checksum !== local.checksum) checksumMismatchNames.push(name);
    if (
      row.finished_at === null ||
      row.rolled_back_at !== null ||
      Boolean(row.logs)
    ) {
      failedNames.push(name);
    } else {
      appliedNames.push(name);
    }
  }

  const pendingNames = localMigrations
    .map((migration) => migration.name)
    .filter((name) => !appliedNames.includes(name));
  const expectedPrefix = localMigrations
    .slice(0, appliedNames.length)
    .map((migration) => migration.name);
  const exactPrefix = appliedNames.every(
    (name, index) => name === expectedPrefix[index],
  );

  return {
    rows: rows.length,
    appliedNames,
    pendingNames,
    failedNames,
    checksumMismatchNames,
    duplicateNames,
    unexpectedNames,
    exactPrefix,
  };
}

export function compareTableInventory(expectedTables, actualTables) {
  const expected = new Set(expectedTables);
  const actual = new Set(actualTables);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(),
    unexpected: [...actual].filter((name) => !expected.has(name)).sort(),
  };
}
