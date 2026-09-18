const defaultTestDatabaseUrl = "postgresql://postgres:postgres@localhost:5432/automation_platform_test";
const databaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;

if (!databaseUrl.includes("/automation_platform_test")) {
  throw new Error("Refusing to run API tests against a database other than automation_platform_test");
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = databaseUrl;
process.env.REDIS_URL ??= "redis://localhost:6379";
