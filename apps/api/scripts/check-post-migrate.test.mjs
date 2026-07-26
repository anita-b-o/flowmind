import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTableInventory,
  deriveTablesFromMigrationSql,
  summarizeMigrationHistory,
  validateDirectNeonUrl,
} from "./post-migrate-checker-lib.mjs";

test("accepts only direct Neon URLs with required TLS and channel binding", () => {
  assert.doesNotThrow(() =>
    validateDirectNeonUrl(
      "postgresql://user:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ),
  );
  for (const invalid of [
    "postgresql://user:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    "postgresql://user:secret@db.example.com/neondb?sslmode=require&channel_binding=require",
    "postgresql://user:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=disable&channel_binding=require",
    "postgresql://user:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require",
  ]) {
    assert.throws(() => validateDirectNeonUrl(invalid));
  }
});

test("derives the final table inventory in migration order", () => {
  assert.deepEqual(
    deriveTablesFromMigrationSql([
      'CREATE TABLE "alpha" (); CREATE TABLE "legacy" ();',
      'ALTER TABLE "alpha" RENAME TO "current"; DROP TABLE "legacy";',
    ]),
    ["current"],
  );
});

test("summarizes a complete, ordered, checksum-valid history", () => {
  const local = [
    { name: "001_init", checksum: "a" },
    { name: "002_next", checksum: "b" },
  ];
  const history = summarizeMigrationHistory(local, [
    row("001_init", "a"),
    row("002_next", "b"),
  ]);
  assert.equal(history.rows, 2);
  assert.deepEqual(history.appliedNames, ["001_init", "002_next"]);
  assert.deepEqual(history.pendingNames, []);
  assert.deepEqual(history.failedNames, []);
  assert.deepEqual(history.checksumMismatchNames, []);
  assert.equal(history.exactPrefix, true);
});

test("reports failed rows, checksum mismatches, and table drift", () => {
  const local = [
    { name: "001_init", checksum: "a" },
    { name: "002_next", checksum: "b" },
  ];
  const history = summarizeMigrationHistory(local, [
    row("001_init", "wrong"),
    { ...row("002_next", "b"), finished_at: null, logs: "failed" },
  ]);
  assert.deepEqual(history.checksumMismatchNames, ["001_init"]);
  assert.deepEqual(history.failedNames, ["002_next"]);
  assert.deepEqual(history.pendingNames, ["002_next"]);
  assert.deepEqual(compareTableInventory(["a", "b"], ["a", "c"]), {
    missing: ["b"],
    unexpected: ["c"],
  });
});

function row(name, checksum) {
  return {
    migration_name: name,
    checksum,
    finished_at: new Date(),
    rolled_back_at: null,
    logs: null,
  };
}
