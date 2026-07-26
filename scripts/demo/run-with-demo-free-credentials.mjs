import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_FAILURE_PREFIX = "demo-free credentials:";
const DIAGNOSTIC_CHECKS = [
  "credentials file path resolved",
  "credentials file exists",
  "credentials path is a regular file",
  "credentials path is not a symlink",
  "credentials file owner matches current uid",
  "credentials file mode is 600",
  "credentials file is outside repository",
  "credentials file has exactly 2 lines",
  "DATABASE_URL key found",
  "REDIS_URL key found",
  "DATABASE_URL is not empty",
  "REDIS_URL is not empty",
  "parser preserves special characters literally",
  "DATABASE_URL is parseable with new URL()",
  "DATABASE_URL protocol is postgresql: or postgres:",
  "Neon hostname contains -pooler",
  "DATABASE_URL sslmode is require",
  "DATABASE_URL channel_binding is require",
  "REDIS_URL is parseable with new URL()",
  "REDIS_URL protocol is rediss:",
  "child environment contains DATABASE_URL",
  "child environment contains REDIS_URL",
];
const repoRoot = await realpath(
  fileURLToPath(new URL("../..", import.meta.url)),
);

try {
  await main();
} catch {
  process.stderr.write(
    `${SAFE_FAILURE_PREFIX} unavailable or invalid; values were not displayed\n`,
  );
  process.exitCode = 1;
}

async function main() {
  const firstArgument = process.argv[2];
  const checkOnly = firstArgument === "--check" && process.argv.length === 3;
  const inspection = await inspectCredentials();
  if (checkOnly) {
    printDiagnostics(inspection.checks);
  }
  if (!inspection.valid) throw new Error("invalid credentials");
  if (checkOnly) return;

  const databaseOnly = firstArgument === "--database-only";
  const commandIndex = databaseOnly ? 3 : 2;
  const command = process.argv[commandIndex];
  if (!command || command === "--check") {
    throw new Error("invalid command");
  }

  await run(
    command,
    process.argv.slice(commandIndex + 1),
    inspection.credentials,
    databaseOnly,
  );
}

async function inspectCredentials() {
  const checks = DIAGNOSTIC_CHECKS.map((label, index) => ({
    id: index + 1,
    label,
    passed: false,
  }));
  const pass = (id, condition) => {
    checks[id - 1].passed = Boolean(condition);
    return Boolean(condition);
  };
  let credentials;

  try {
    const home = process.env.HOME;
    if (!home) return { checks, credentials, valid: false };

    const credentialsPath = resolve(
      home,
      ".config",
      "flowmind",
      "demo-free.env",
    );
    if (!pass(1, isAbsolute(credentialsPath))) {
      return { checks, credentials, valid: false };
    }

    let pathInfo;
    try {
      pathInfo = await lstat(credentialsPath);
      pass(2, true);
    } catch {
      return { checks, credentials, valid: false };
    }

    const regularFile = pass(3, pathInfo.isFile());
    const notSymlink = pass(4, !pathInfo.isSymbolicLink());
    if (!regularFile || !notSymlink) {
      return { checks, credentials, valid: false };
    }

    const handle = await open(
      credentialsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
        return { checks, credentials, valid: false };
      }

      const ownerMatches =
        typeof process.getuid !== "function" || info.uid === process.getuid();
      const ownerSafe = pass(5, ownerMatches);
      const modeSafe = pass(6, (info.mode & 0o7777) === 0o600);

      const canonicalPath = await realpath(`/proc/self/fd/${handle.fd}`);
      const repoRelativePath = relative(repoRoot, canonicalPath);
      const outsideRepository =
        repoRelativePath !== "" &&
        (repoRelativePath === ".." || repoRelativePath.startsWith(`..${sep}`));
      const pathSafe = pass(7, outsideRepository);
      if (!ownerSafe || !modeSafe || !pathSafe) {
        return { checks, credentials, valid: false };
      }

      const parsed = parseCredentials(await handle.readFile("utf8"));
      pass(8, parsed.lineCount === 2);
      pass(9, parsed.hasDatabaseUrl);
      pass(10, parsed.hasRedisUrl);
      pass(11, parsed.databaseUrlNotEmpty);
      pass(12, parsed.redisUrlNotEmpty);
      pass(13, parserPreservesSpecialCharacters());
      credentials = parsed.credentials;
    } finally {
      await handle.close();
    }
  } catch {
    return { checks, credentials, valid: false };
  }

  if (!credentials) return { checks, credentials, valid: false };

  let database;
  try {
    database = new URL(credentials.DATABASE_URL);
    pass(14, true);
  } catch {
    // The safe diagnostic records only PASS/FAIL.
  }
  if (database) {
    pass(15, ["postgres:", "postgresql:"].includes(database.protocol));
    pass(16, database.hostname.toLowerCase().includes("-pooler"));
    pass(
      17,
      database.searchParams.getAll("sslmode").length === 1 &&
        database.searchParams.get("sslmode") === "require",
    );
    pass(
      18,
      database.searchParams.getAll("channel_binding").length === 1 &&
        database.searchParams.get("channel_binding") === "require",
    );
  }

  let redis;
  try {
    redis = new URL(credentials.REDIS_URL);
    pass(19, true);
  } catch {
    // The safe diagnostic records only PASS/FAIL.
  }
  if (redis) pass(20, redis.protocol === "rediss:");

  const childEnv = buildChildEnvironment(credentials, false);
  pass(
    21,
    Object.hasOwn(childEnv, "DATABASE_URL") &&
      childEnv.DATABASE_URL === credentials.DATABASE_URL,
  );
  pass(
    22,
    Object.hasOwn(childEnv, "REDIS_URL") &&
      childEnv.REDIS_URL === credentials.REDIS_URL,
  );

  return {
    checks,
    credentials,
    valid: checks.every(({ passed }) => passed),
  };
}

function parseCredentials(contents) {
  const lines = splitCredentialLines(contents);
  const entries = new Map();
  let structurallyValid = true;

  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      structurallyValid = false;
      continue;
    }

    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !["DATABASE_URL", "REDIS_URL"].includes(name) ||
      entries.has(name) ||
      value.includes("\r")
    ) {
      structurallyValid = false;
      continue;
    }
    entries.set(name, value);
  }

  const hasDatabaseUrl = entries.has("DATABASE_URL");
  const hasRedisUrl = entries.has("REDIS_URL");
  const databaseUrlNotEmpty =
    hasDatabaseUrl && entries.get("DATABASE_URL").length > 0;
  const redisUrlNotEmpty = hasRedisUrl && entries.get("REDIS_URL").length > 0;
  const valid =
    structurallyValid &&
    lines.length === 2 &&
    entries.size === 2 &&
    databaseUrlNotEmpty &&
    redisUrlNotEmpty;

  return {
    credentials: valid ? Object.fromEntries(entries) : undefined,
    lineCount: lines.length,
    hasDatabaseUrl,
    hasRedisUrl,
    databaseUrlNotEmpty,
    redisUrlNotEmpty,
  };
}

function splitCredentialLines(contents) {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function parserPreservesSpecialCharacters() {
  const marker = "literal&$%?#=value";
  const probe = parseCredentials(
    `DATABASE_URL=${marker}\nREDIS_URL=${marker}\n`,
  );
  return (
    probe.credentials?.DATABASE_URL === marker &&
    probe.credentials?.REDIS_URL === marker
  );
}

function printDiagnostics(checks) {
  for (const { id, label, passed } of checks) {
    const number = String(id).padStart(2, "0");
    process.stderr.write(
      `${SAFE_FAILURE_PREFIX} ${number}. ${label}: ${passed ? "PASS" : "FAIL"}\n`,
    );
  }
}

function buildChildEnvironment(credentials, databaseOnly) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  env.DATABASE_URL = credentials.DATABASE_URL;
  if (!databaseOnly) env.REDIS_URL = credentials.REDIS_URL;
  return env;
}

async function run(command, args, credentials, databaseOnly) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: buildChildEnvironment(credentials, databaseOnly),
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const stdout = redactLines(child.stdout, process.stdout, credentials);
  const stderr = redactLines(child.stderr, process.stderr, credentials);

  const forwardSigint = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
    }
  };
  const forwardSigterm = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);

  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  await Promise.all([stdout, stderr]);

  process.removeListener("SIGINT", forwardSigint);
  process.removeListener("SIGTERM", forwardSigterm);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

async function redactLines(input, output, credentials) {
  let pending = "";
  for await (const chunk of input) {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      output.write(`${redact(line, credentials)}\n`);
    }
  }
  if (pending) output.write(redact(pending, credentials));
}

function redact(value, credentials) {
  let output = String(value);
  for (const secret of Object.values(credentials)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(
    /((?:postgres(?:ql)?|rediss?):\/\/)[^\s"']+/gi,
    "$1[REDACTED]",
  );
}
