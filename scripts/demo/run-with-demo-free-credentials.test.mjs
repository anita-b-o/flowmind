import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(
  new URL("./run-with-demo-free-credentials.mjs", import.meta.url),
);
const databaseUrl =
  "postgresql://role:secret%24%26%25%3F%23@ep-demo-pooler.example.test/db?sslmode=require&channel_binding=require&application_name=literal%24%26%25%3F%23#fragment-$-%-?-&";
const redisUrl =
  "rediss://default:secret%24%26%25%3F%23@redis.example.test:6379/0?note=literal%24%26%25%3F%23#fragment-$-%-?-&";

test("synthetic dry-run passes both credentials to the child and redacts output", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeCredentials(credentialsPath);
    await writeFile(
      join(home, ".env.local"),
      "DEMO_FREE_DOTENV_SENTINEL=must-not-load\n",
    );

    const childScript = [
      `assert.equal(process.env.DATABASE_URL, ${JSON.stringify(databaseUrl)});`,
      `assert.equal(process.env.REDIS_URL, ${JSON.stringify(redisUrl)});`,
      "assert.equal(process.env.DEMO_FREE_DOTENV_SENTINEL, undefined);",
      "process.stdout.write(process.env.DATABASE_URL);",
      "process.stderr.write(process.env.REDIS_URL);",
    ].join("");
    const result = invoke(home, [
      process.execPath,
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";${childScript}`,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "[REDACTED]");
    assert.equal(result.stderr, "[REDACTED]");
    assert.equal(await readFile(credentialsPath, "utf8"), fileContents());
  });
});

test("rejects permissions more permissive than 600 without leaking values", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeCredentials(credentialsPath);
    await chmod(credentialsPath, 0o644);

    const result = invoke(home, ["--check"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /values were not displayed/);
    assert.doesNotMatch(result.stderr, /role|secret|upstash/);
  });
});

test("reports all safe credential diagnostics without displaying values", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeCredentials(credentialsPath);

    const result = invoke(home, ["--check"]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.match(/: PASS/g)?.length, 22);
    assert.doesNotMatch(result.stderr, /secret|example\.test|fragment/);
  });
});

test("preserves special characters and accepts CRLF dotenv records", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeFile(credentialsPath, fileContents("\r\n"), { mode: 0o600 });
    const childScript = [
      `assert.equal(process.env.DATABASE_URL, ${JSON.stringify(databaseUrl)});`,
      `assert.equal(process.env.REDIS_URL, ${JSON.stringify(redisUrl)});`,
    ].join("");

    const result = invoke(home, [
      process.execPath,
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";${childScript}`,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

test("requires channel_binding=require but not unrelated pool tuning parameters", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    const withoutChannelBinding = databaseUrl.replace(
      "&channel_binding=require",
      "",
    );
    await writeFile(
      credentialsPath,
      fileContents("\n", withoutChannelBinding),
      { mode: 0o600 },
    );

    const result = invoke(home, ["--check"]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /18\. DATABASE_URL channel_binding is require: FAIL/,
    );
    assert.doesNotMatch(result.stderr, /secret|example\.test|fragment/);
  });
});

test("rejects extra entries and inherited credential overrides", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeFile(
      credentialsPath,
      `${fileContents()}UNEXPECTED=postgresql://leak:me@example.test/db\n`,
      { mode: 0o600 },
    );

    const result = invoke(home, ["--check"], {
      DATABASE_URL: "postgresql://inherited:secret@example.test/db",
      REDIS_URL: "rediss://inherited:secret@example.test",
    });

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /inherited|leak|secret/);
  });
});

test("database-only mode does not expose Redis credentials to its child", async () => {
  await withHome(async ({ home, credentialsPath }) => {
    await writeCredentials(credentialsPath);
    const childScript = [
      `assert.equal(process.env.DATABASE_URL, ${JSON.stringify(databaseUrl)});`,
      "assert.equal(process.env.REDIS_URL, undefined);",
    ].join("");

    const result = invoke(home, [
      "--database-only",
      process.execPath,
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";${childScript}`,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

async function withHome(callback) {
  const home = await mkdtemp(join(tmpdir(), "flowmind-demo-free-test-"));
  const configDirectory = join(home, ".config", "flowmind");
  const credentialsPath = join(configDirectory, "demo-free.env");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  try {
    await callback({ home, credentialsPath });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeCredentials(path) {
  await writeFile(path, fileContents(), { mode: 0o600 });
}

function fileContents(lineEnding = "\n", selectedDatabaseUrl = databaseUrl) {
  return [
    `DATABASE_URL=${selectedDatabaseUrl}`,
    `REDIS_URL=${redisUrl}`,
    "",
  ].join(lineEnding);
}

function invoke(home, args, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    HOME: home,
  };
  delete env.DEMO_FREE_DOTENV_SENTINEL;
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: home,
    encoding: "utf8",
    env,
  });
}
