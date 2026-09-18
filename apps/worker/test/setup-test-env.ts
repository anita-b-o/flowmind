const defaultTestDatabaseUrl = "postgresql://postgres:postgres@localhost:5432/automation_platform_test";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultTestDatabaseUrl;
const database = new URL(databaseUrl);
const allowedChaosDatabase =
  process.env.CHAOS_COMPOSE_PROJECT !== undefined &&
  database.pathname === "/flowmind_chaos" &&
  ["localhost", "127.0.0.1", "::1"].includes(database.hostname);

if (database.pathname !== "/automation_platform_test" && !allowedChaosDatabase) {
  throw new Error("Refusing to run worker tests against a database other than automation_platform_test or local flowmind_chaos");
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = databaseUrl;
process.env.REDIS_URL ??= "redis://localhost:6379";
