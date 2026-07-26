import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const requireFromApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const requireFromWorker = createRequire(
  new URL("../../apps/worker/package.json", import.meta.url),
);
const { PrismaClient } = requireFromApi("@prisma/client");
const Redis = requireFromWorker("ioredis").default;
const { Queue, QueueEvents } = requireFromWorker("bullmq");

const prisma = new PrismaClient();
const gateStartedAt = new Date();
const gatePrefix = `demo-real-gate-${Date.now()}-${randomUUID().slice(0, 8)}`;
const apiOrigin = "http://127.0.0.1:3001";
const graphWorkflowId = "00000000-0000-4000-8000-000000000101";
const approvalWorkflowId = "00000000-0000-4000-8000-000000000102";
const demoEmail = "demo@example.com";
const demoPassword = `${randomBytes(24).toString("base64url")}Aa1!`;
const trackedExecutionIds = new Set();
const trackedIdempotencyKeys = new Set();
const initialSessionIds = new Set();
const runtimeLogTail = [];
const result = {
  neon: {},
  upstash: {},
  runtime: {},
  seed: {},
  journey: {},
  recovery: {},
  redis: {},
  memory: {},
  lifecycle: {},
  limitations: [],
  latencyMs: {},
  cleanup: {},
  blockers: [],
};

let runtime;
let redis;
let queue;
let queueEvents;
let auth;
let demoOrganization;
let demoUser;
let fatal;
let seedCompleted = false;

try {
  await run();
} catch (error) {
  fatal = error;
  result.blockers.push(safeError(error));
} finally {
  await stopRuntime().catch((error) =>
    result.blockers.push(`runtime stop: ${safeError(error)}`),
  );
  await cleanupGateFixtures().catch((error) =>
    result.blockers.push(`fixture cleanup: ${safeError(error)}`),
  );
  await queueEvents?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  redis?.disconnect();
  await prisma.$disconnect().catch(() => undefined);
}

process.stdout.write(`GATE_RESULT=${JSON.stringify(result)}\n`);
if (fatal) {
  process.stderr.write("demo-real-runtime-gate: failed; details redacted\n");
  process.exitCode = 1;
}

async function run() {
  validateServiceUrls();
  await validateRuntimeConnections();
  progress("connections-valid");

  await startRuntime();
  progress("runtime-ready");

  await seedTwice();
  progress("seed-idempotent");

  const baselineBefore = await redisCommands();
  await runJourney("initial");
  const baselineAfter = await redisCommands();
  result.redis.journeyDelta = nonNegativeDelta(baselineBefore, baselineAfter);
  if (result.redis.journeyDelta === 0) {
    result.limitations.push(
      "Upstash INFO stats returned a static total_commands_processed counter during a proven journey; the zero delta is invalid and must not reduce the session budget",
    );
  }
  progress("journey-complete");

  await runRecoverySuite();
  progress("recovery-complete");

  await runMemoryGate();
  progress("memory-gate-complete");

  calculateRedisBudget();
  progress("redis-budget-complete");

  await runSpinDownLifecycle();
  progress("spin-down-lifecycle-complete");
}

function validateServiceUrls() {
  const database = new URL(required("DATABASE_URL"));
  const hostname = database.hostname.toLowerCase();
  const neonHost =
    hostname.startsWith("ep-") && hostname.endsWith(".neon.tech");
  const pooledHost = neonHost && hostname.includes("-pooler.");
  const tlsRequired = database.searchParams.get("sslmode") === "require";
  const channelBinding = database.searchParams.get("channel_binding");
  result.neon = {
    mode: pooledHost ? "pooled" : "invalid",
    neonHost,
    pooledHost,
    tls: tlsRequired,
    channelBinding: channelBinding ?? "not-set",
  };
  expect(pooledHost, "runtime DATABASE_URL must use the pooled Neon endpoint");
  expect(tlsRequired, "runtime DATABASE_URL must require TLS");
  if (channelBinding !== null) {
    expect(
      channelBinding === "require",
      "Neon channel binding must be require",
    );
  }
  const redisUrl = new URL(required("REDIS_URL"));
  expect(redisUrl.protocol === "rediss:", "Upstash must use rediss");
  result.upstash = {
    tls: true,
    ping: false,
    bullmq: false,
    queueEvents: false,
  };
}

async function validateRuntimeConnections() {
  const probe = new PrismaClient();
  try {
    await probe.$connect();
    const rows = await Promise.all(
      Array.from(
        { length: 8 },
        () => probe.$queryRaw`SELECT pg_backend_pid()::int AS pid`,
      ),
    );
    result.neon.connection = true;
    result.neon.concurrentQueries = rows.length;
    result.neon.observedBackendConnections = new Set(
      rows.map((entry) => entry[0]?.pid),
    ).size;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }

  redis = new Redis(redisOptions(process.env.REDIS_URL));
  expect((await redis.ping()) === "PONG", "Upstash PING");
  result.upstash.ping = true;

  queue = new Queue("workflow-executions", {
    connection: redisOptions(process.env.REDIS_URL),
  });
  await queue.waitUntilReady();
  result.upstash.bullmq = true;
  queueEvents = new QueueEvents("workflow-executions", {
    connection: redisOptions(process.env.REDIS_URL),
  });
  await queueEvents.waitUntilReady();
  result.upstash.queueEvents = true;
}

function runtimeEnv() {
  return {
    ...process.env,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=256",
    FLOWMIND_DEPLOYMENT_PROFILE: "demo-free",
    FLOWMIND_AI_MODE: "embedded-fake",
    FLOWMIND_EMAIL_MODE: "embedded-fake",
    FLOWMIND_DEMO_EMAIL: demoEmail,
    FLOWMIND_DEMO_PASSWORD: demoPassword,
    JWT_ACCESS_SECRET: randomBytes(32).toString("base64url"),
    JWT_REFRESH_SECRET: randomBytes(32).toString("base64url"),
    SESSION_IP_HASH_PEPPER: randomBytes(32).toString("base64url"),
    WEBHOOK_TOKEN_PEPPER: randomBytes(32).toString("base64url"),
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    CONNECTION_ENCRYPTION_KEY: `base64:${randomBytes(32).toString("base64")}`,
    PORT: "3001",
    CORS_ORIGIN: apiOrigin,
    PUBLIC_APP_URL: apiOrigin,
    PUBLIC_API_URL: apiOrigin,
    AUTH_ORIGIN_REQUIRED: "false",
    REFRESH_COOKIE_SAME_SITE: "lax",
    REFRESH_COOKIE_PATH: "/api/auth",
    DEMO_REGISTRATION_ENABLED: "false",
    BULLMQ_DRAIN_DELAY_SECONDS: "30",
    WORKER_SHUTDOWN_TIMEOUT_MS: "20000",
    EXECUTION_RECONCILIATION_INTERVAL_MS: "15000",
    NOTIFICATION_RECONCILIATION_INTERVAL_MS: "15000",
    INTERNAL_EVENT_POLL_INTERVAL_MS: "5000",
    DEMO_TELEMETRY_INTERVAL_MS: "60000",
    METRICS_ENABLED: "false",
    METRICS_API_KEY: randomBytes(32).toString("base64url"),
    LOG_LEVEL: "info",
    LOG_FORMAT: "json",
    LOG_REDACT_ENABLED: "true",
  };
}

async function startRuntime() {
  const startedAt = performance.now();
  runtime = spawn(process.execPath, ["apps/demo-runtime/dist/main.js"], {
    cwd: process.cwd(),
    env: runtimeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureRuntimeLogs(runtime.stdout);
  captureRuntimeLogs(runtime.stderr);
  const readiness = await poll(
    async () => {
      ensureRuntimeAlive();
      return rawRequest("/health/ready").catch(() => undefined);
    },
    (response) => response?.status === 200 && response.body?.status === "ready",
    90_000,
    500,
    "runtime readiness",
  );
  result.runtime.started = true;
  result.runtime.pid = runtime.pid;
  result.runtime.startupMs = Math.round(performance.now() - startedAt);
  result.runtime.startupMeasurementsMs ??= [];
  result.runtime.startupMeasurementsMs.push(result.runtime.startupMs);
  result.runtime.initialStartupMs ??= result.runtime.startupMs;
  result.runtime.readiness = readiness.body;
  result.runtime.workerContext =
    readiness.body?.checks?.embeddedWorker === "up";
  result.runtime.reconciler =
    readiness.body?.checks?.["worker.reconciler"] === "up";
  result.runtime.dispatcher =
    readiness.body?.checks?.["worker.eventDispatcher"] === "up";
  result.runtime.bullmqConsumers =
    readiness.body?.checks?.["worker.executionProcessor"] === "up" &&
    readiness.body?.checks?.["worker.notificationProcessor"] === "up";
  result.runtime.prisma =
    readiness.body?.checks?.database === "up" &&
    readiness.body?.checks?.["worker.database"] === "up";
  result.runtime.redis =
    readiness.body?.checks?.redis === "up" &&
    readiness.body?.checks?.["worker.redis"] === "up";
  expect(
    result.runtime.workerContext &&
      result.runtime.reconciler &&
      result.runtime.dispatcher &&
      result.runtime.bullmqConsumers &&
      result.runtime.prisma &&
      result.runtime.redis,
    "aggregate readiness components",
  );
}

async function stopRuntime() {
  if (!runtime || runtime.exitCode !== null) return;
  const startedAt = performance.now();
  runtime.kill("SIGTERM");
  const exit = await waitForChild(runtime, 25_000);
  result.runtime.gracefulShutdown =
    exit.signal === null &&
    performance.now() - startedAt <= 25_000 &&
    runtimeLogTail.some((line) =>
      line.includes("demo-runtime.shutdown.completed"),
    );
  result.runtime.shutdownMs = Math.round(performance.now() - startedAt);
  runtime = undefined;
}

async function seedTwice() {
  const before = await seedState();
  if (before.userId) {
    for (const session of await prisma.refreshTokenSession.findMany({
      where: { userId: before.userId },
      select: { id: true },
    })) {
      initialSessionIds.add(session.id);
    }
  }
  const first = await runChild(
    process.execPath,
    ["scripts/demo/seed-demo.mjs"],
    {
      env: runtimeEnv(),
      timeoutMs: 120_000,
    },
  );
  expect(first.code === 0, "seed run 1");
  const afterFirst = await seedState();
  const second = await runChild(
    process.execPath,
    ["scripts/demo/seed-demo.mjs"],
    { env: runtimeEnv(), timeoutMs: 120_000 },
  );
  expect(second.code === 0, "seed run 2");
  const afterSecond = await seedState();
  expect(
    JSON.stringify(seedCounts(afterFirst)) ===
      JSON.stringify(seedCounts(afterSecond)),
    "seed idempotency",
  );
  expect(
    afterSecond.users === 1 &&
      afterSecond.organizations === 1 &&
      afterSecond.workflows === 2 &&
      afterSecond.workflowVersions >= 2 &&
      afterSecond.connections === 1 &&
      afterSecond.notificationRules === 1,
    "seed expected resources",
  );
  result.seed = {
    run1: true,
    run2: true,
    idempotent: true,
    user: demoEmail,
    organization: afterSecond.organizationId,
    workflows: afterSecond.workflowNames,
    approvalWorkflow: afterSecond.workflowNames.some((name) =>
      name.includes("Approval"),
    ),
    fakeNotificationRule: true,
    dataStoreStepPresent: afterSecond.stepTypes.includes("data_store"),
    databaseRecordStepPresent:
      afterSecond.stepTypes.includes("database_record"),
  };
  demoOrganization = await prisma.organization.findUniqueOrThrow({
    where: { slug: "flowmind-demo" },
  });
  demoUser = await prisma.user.findUniqueOrThrow({
    where: { email: demoEmail },
  });
  seedCompleted = true;
}

async function runJourney(label) {
  const loginStarted = performance.now();
  const login = await apiRequest("/auth/login", {
    method: "POST",
    body: { email: demoEmail, password: demoPassword },
    unauthenticated: true,
  });
  pushLatency("login", performance.now() - loginStarted);
  auth = {
    token: login.accessToken,
    organizationId:
      login.defaultOrganizationId ??
      login.organizationId ??
      demoOrganization.id,
  };
  expect(auth.token && auth.organizationId, "demo login");

  const workflows = await apiRequest("/workflows");
  expect(Array.isArray(workflows) && workflows.length >= 2, "workflow list");
  const graph = workflows.find((item) => item.id === graphWorkflowId);
  const approvalWorkflow = workflows.find(
    (item) => item.id === approvalWorkflowId,
  );
  expect(graph && approvalWorkflow, "seed workflows visible");

  const executionStarted = performance.now();
  const graphExecution = await startManual(graphWorkflowId, {
    trigger: {
      input: {
        text: `urgent ${gatePrefix} ${label}`,
        priority: "urgent",
      },
    },
  });
  const graphDone = await waitExecution(graphExecution, "COMPLETED");
  pushLatency("execution", performance.now() - executionStarted);
  const stepKeys = graphDone.steps?.map((step) => step.stepKey) ?? [];
  expect(
    stepKeys.includes("urgent_summary") &&
      graphDone.steps.some(
        (step) =>
          step.stepKey === "normal_summary" && step.status === "SKIPPED",
      ),
    "Graph v2 real branch",
  );
  const aiStep = await prisma.stepExecution.findFirst({
    where: {
      executionId: graphExecution,
      stepKey: "urgent_summary",
      status: "COMPLETED",
    },
    select: { outputJson: true },
  });
  expect(
    typeof aiStep?.outputJson?.summary === "string" &&
      aiStep.outputJson.summary.includes(`urgent ${gatePrefix}`),
    "embedded fake AI summary",
  );
  expect(
    (await prisma.internalRecord.count({
      where: {
        executionId: graphExecution,
        collection: "demo_journey",
      },
    })) === 1,
    "DatabaseRecord demo step",
  );

  const approvalStarted = performance.now();
  const approvalExecution = await startManual(approvalWorkflowId, {
    trigger: { request: `${gatePrefix}-${label}` },
  });
  const pendingApproval = await poll(
    async () => {
      const response = await apiRequest("/approvals?status=PENDING");
      const items = Array.isArray(response) ? response : response.items;
      return items?.find((item) => item.executionId === approvalExecution);
    },
    Boolean,
    45_000,
    250,
    "approval pending",
  );
  await apiRequest(`/approvals/${pendingApproval.id}/approve`, {
    method: "POST",
    body: { comment: "approved by local demo gate" },
  });
  const approvalDone = await waitExecution(approvalExecution, "COMPLETED");
  pushLatency("approvalResume", performance.now() - approvalStarted);
  expect(
    approvalDone.id === approvalExecution,
    "approval resumes same execution",
  );

  const replayStarted = performance.now();
  const replayResponse = await apiRequest(
    `/executions/${graphExecution}/replay`,
    {
      method: "POST",
      body: { mode: "FULL_REPLAY", reason: "local demo gate" },
      idempotencyKey: `${gatePrefix}-replay-${label}`,
    },
  );
  const replayId = replayResponse.execution.id;
  trackedExecutionIds.add(replayId);
  trackedIdempotencyKeys.add(`${gatePrefix}-replay-${label}`);
  const replayDone = await waitExecution(replayId, "COMPLETED");
  pushLatency("replay", performance.now() - replayStarted);
  expect(
    replayDone.replayOfExecutionId === graphExecution,
    "replay lineage via API",
  );

  const timeline = await apiRequest(
    `/executions/${graphExecution}/timeline?limit=100`,
  );
  const history = await apiRequest(
    `/executions?workflowId=${graphWorkflowId}&limit=20`,
  );
  expect(
    (timeline.items?.length ?? 0) > 0 &&
      history.items?.some((item) => item.id === graphExecution),
    "run history and timeline",
  );

  const notification = await poll(
    async () => {
      const response = await apiRequest("/notifications?pageSize=100");
      const items = Array.isArray(response) ? response : response.items;
      return items?.find(
        (item) =>
          item.status === "SENT" &&
          (item.correlationId === graphDone.correlationId ||
            item.correlationId === replayDone.correlationId),
      );
    },
    Boolean,
    45_000,
    500,
    "fake notification sent",
  );
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { notificationRequestId: notification.id },
  });
  expect(
    delivery?.providerMessageId?.startsWith("flowmind-demo-"),
    "embedded fake notification provider",
  );

  result.journey = {
    login: true,
    workflowList: true,
    graphV2: true,
    branch: "urgent",
    fakeAi: true,
    dataStore:
      result.seed.dataStoreStepPresent || result.seed.databaseRecordStepPresent,
    approvalPending: true,
    approvalResumedSameExecution: true,
    completed: true,
    replay: true,
    runHistory: true,
    timeline: true,
    fakeNotification: true,
  };
  if (!result.journey.dataStore) {
    addBlocker(
      "The existing demo seed has no Data Store/DatabaseRecord step; no feature was added",
    );
  }
}

async function runRecoverySuite() {
  const seed = await recoverySeed();

  const missing = await createDurableExecution(seed, "missing-job", {
    status: "QUEUED",
  });
  await waitExecutionDatabase(missing.id, "COMPLETED", 60_000);
  result.recovery.missingJob = true;

  const duplicate = await createDurableExecution(seed, "duplicate-job", {
    status: "QUEUED",
  });
  const payload = jobPayload(duplicate, seed);
  const jobId = `execution-${duplicate.id}`;
  await Promise.all([
    queue.add("execution.run", payload, jobOptions(jobId)),
    queue.add("execution.run", payload, jobOptions(jobId)),
  ]);
  await waitExecutionDatabase(duplicate.id, "COMPLETED", 60_000);
  const duplicateRead = await prisma.execution.findUniqueOrThrow({
    where: { id: duplicate.id },
    include: { steps: true },
  });
  expect(
    (await prisma.execution.count({ where: { id: duplicate.id } })) === 1 &&
      new Set(duplicateRead.steps.map((step) => step.stepKey)).size ===
        duplicateRead.steps.length,
    "duplicate logical job deduplication",
  );
  result.recovery.duplicateJob = true;

  const expired = await createDurableExecution(seed, "expired-lease", {
    status: "RUNNING",
    lockedBy: `${gatePrefix}-dead-worker`,
    lockedUntil: new Date(Date.now() - 1000),
    lastHeartbeatAt: new Date(Date.now() - 2000),
  });
  await waitExecutionDatabase(expired.id, "COMPLETED", 60_000);
  result.recovery.expiredLease = true;

  result.recovery.redisOutage = "not-induced";
  result.limitations.push(
    "A real Redis outage was not induced because Upstash Free does not grant the administrative controls required for CLIENT PAUSE or CLIENT KILL; restart recovery is exercised instead",
  );
}

async function runMemoryGate() {
  const samples = [];
  const sampleElapsedSeconds = [];
  const errors = [];
  const journeyCommandDeltas = [];
  const redisBefore = await redisCommands();
  const cpuBefore = await readCpuTicks(runtime.pid);
  const startedAt = Date.now();
  const sampleCount = 61;
  let workflows = 0;
  let loadError;

  const loadPromise = (async () => {
    const journeyCount = 10;
    const journeyIntervalMs = 180_000;
    for (let index = 0; index < journeyCount; index += 1) {
      const target = startedAt + index * journeyIntervalMs;
      if (Date.now() < target) await delay(target - Date.now());
      const journeyBefore = await redisCommands();
      await runJourney(`memory-${index}`);
      const journeyAfter = await redisCommands();
      journeyCommandDeltas.push(
        Math.max(0, nonNegativeDelta(journeyBefore, journeyAfter) - 1),
      );
      workflows += 1;
    }
  })().catch((error) => {
    loadError = error;
    errors.push(safeError(error));
  });

  for (let index = 0; index < sampleCount; index += 1) {
    const target = startedAt + index * 30_000;
    if (Date.now() < target) await delay(target - Date.now());
    ensureRuntimeAlive();
    samples.push(await readRssMiB(runtime.pid));
    sampleElapsedSeconds.push((Date.now() - startedAt) / 1000);
    progress(
      `memory-sample-${index + 1}/${sampleCount}-rss-${samples.at(-1)}MiB`,
    );
    if (samples.at(-1) > 430) {
      throw new Error("memory RSS exceeded 430 MiB");
    }
    if (loadError) throw loadError;
  }

  await loadPromise;
  if (loadError) throw loadError;
  const cpuAfter = await readCpuTicks(runtime.pid);
  const redisAfter = await redisCommands();
  const redisCommandDelta = nonNegativeDelta(redisBefore, redisAfter);
  const redisCounterReliable =
    redisCommandDelta > 0 &&
    journeyCommandDeltas.length > 0 &&
    journeyCommandDeltas.every((value) => value > 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const average =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const slope = linearSlopeByX(sampleElapsedSeconds, samples) * 3600;
  const peak = Math.max(...samples);
  const final = samples.at(-1);
  const initial = samples[0];
  const clockTicks = Number(
    spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim() ||
      100,
  );
  const cpuSeconds = (cpuAfter - cpuBefore) / clockTicks;
  const wallSeconds = sampleElapsedSeconds.at(-1);
  const averageCpuPercent = (cpuSeconds / wallSeconds) * 100;
  const renderViable =
    peak < 400 &&
    peak <= 430 &&
    slope <= 5 &&
    errors.length === 0 &&
    runtime.exitCode === null;

  result.memory = {
    durationSeconds: Math.round(wallSeconds),
    samples: samples.length,
    sampleIntervalSeconds: 30,
    maxSampleLatenessSeconds: round(
      Math.max(
        ...sampleElapsedSeconds.map((elapsed, index) => elapsed - index * 30),
      ),
      3,
    ),
    initialRssMiB: initial,
    minRssMiB: Math.min(...samples),
    averageRssMiB: round(average, 2),
    p95RssMiB: p95,
    peakRssMiB: peak,
    finalRssMiB: final,
    trendMiBPerHour: round(slope, 2),
    journeys: workflows,
    redisCommandsInitial: redisBefore,
    redisCommandsFinal: redisAfter,
    redisCommandDelta,
    redisCounterReliable,
    redisCommandsPerMinute: round(redisCommandDelta / (wallSeconds / 60), 2),
    redisJourneyCommandDeltas: journeyCommandDeltas,
    redisCommandsPerJourney: round(
      journeyCommandDeltas.reduce((sum, value) => sum + value, 0) /
        journeyCommandDeltas.length,
      2,
    ),
    errors,
    oomOrRestart: runtime.exitCode !== null,
    averageCpuPercent: round(averageCpuPercent, 2),
    marginTo512MiB: 512 - peak,
    renderFreeViable: renderViable,
  };
  if (!renderViable) {
    addBlocker("The 30-minute memory/CPU gate did not meet limits");
  }
}

function calculateRedisBudget() {
  const quota = 500_000;
  const operationalCeiling = 400_000;
  const activeAwakeMinutes = 15;
  const idleCommandsPerMinute = 113.6;
  const previousJourneyCommands = 576;
  const coherentRehearsalJourneyCommands = 607;
  const measuredJourneyCommands = Math.ceil(
    result.memory.redisCommandsPerJourney ?? previousJourneyCommands,
  );
  const journeyCommands = Math.max(
    previousJourneyCommands,
    coherentRehearsalJourneyCommands,
    measuredJourneyCommands,
  );
  const awakeWindowCommands = Math.ceil(
    idleCommandsPerMinute * activeAwakeMinutes,
  );
  const baseSessionCommands = awakeWindowCommands + journeyCommands;
  const contingencyPercent = 25;
  const sessionCommandBudget =
    Math.ceil((baseSessionCommands * (1 + contingencyPercent / 100)) / 500) *
    500;
  const dailyScenarios = [1, 3, 5, 7, 10].map((sessionsPerDay) => {
    const monthlyCommands = sessionCommandBudget * sessionsPerDay * 30;
    return {
      sessionsPerDay,
      monthlyCommands,
      marginToQuota: quota - monthlyCommands,
      quotaPercent: round((monthlyCommands / quota) * 100, 1),
      withinQuota: monthlyCommands <= quota,
      withinOperationalCeiling: monthlyCommands <= operationalCeiling,
    };
  });
  const recommendedMaxDailySessions = Math.min(
    3,
    Math.max(
      0,
      ...dailyScenarios
        .filter((scenario) => scenario.withinOperationalCeiling)
        .map((scenario) => scenario.sessionsPerDay),
    ),
  );

  result.redis.sessionBudget = {
    quota,
    operationalCeiling,
    activeAwakeMinutes,
    idleCommandsPerMinute,
    awakeWindowCommands,
    previousJourneyCommands,
    coherentRehearsalJourneyCommands,
    measuredJourneyCommands,
    journeyCommandsUsed: journeyCommands,
    baseSessionCommands,
    contingencyPercent,
    contingencyPurpose:
      "startup/recovery, additional navigation, and occasional retries",
    sessionCommandBudget,
    dailyScenarios,
    recommendedMaxDailySessions,
    viable:
      recommendedMaxDailySessions > 0 &&
      sessionCommandBudget * recommendedMaxDailySessions * 30 <=
        operationalCeiling,
  };
  if (!result.redis.sessionBudget.viable) {
    addBlocker(
      "Redis scale-to-zero session budget does not leave a conservative portfolio allowance",
    );
  }
}

async function runSpinDownLifecycle() {
  const seed = await recoverySeed();
  await stopRuntime();

  await queueEvents?.close();
  queueEvents = undefined;
  await queue?.close();
  queue = undefined;

  const stoppedSeconds = 120;
  const stoppedRedisInitial = await redisCommands();
  await delay(stoppedSeconds * 1000);
  const stoppedRedisFinal = await redisCommands();
  const stoppedRedisRawDelta = nonNegativeDelta(
    stoppedRedisInitial,
    stoppedRedisFinal,
  );
  const stoppedRedisMaterialDelta = Math.max(0, stoppedRedisRawDelta - 1);

  const durable = await createDurableExecution(seed, "spin-down-recovery", {
    status: "QUEUED",
  });
  const recoveryStartedAt = performance.now();
  await startRuntime();
  await waitExecutionDatabase(durable.id, "COMPLETED", 60_000);
  const recovered = await prisma.execution.findUniqueOrThrow({
    where: { id: durable.id },
    include: { steps: true },
  });
  const duplicateExecutionCount = await prisma.execution.count({
    where: { id: durable.id },
  });
  const uniqueStepCount = new Set(recovered.steps.map((step) => step.stepKey))
    .size;
  const noDuplicates =
    duplicateExecutionCount === 1 && uniqueStepCount === recovered.steps.length;

  result.lifecycle = {
    runtimeStopped: true,
    stoppedSeconds,
    stoppedRedisInitial,
    stoppedRedisFinal,
    stoppedRedisRawDelta,
    stoppedRedisMaterialDelta,
    stoppedRedisCommandsPerMinute: round(
      stoppedRedisMaterialDelta / (stoppedSeconds / 60),
      2,
    ),
    redisStoppedMaterially: stoppedRedisMaterialDelta <= 2,
    durableExecutionId: durable.id,
    localColdStartMs: result.runtime.startupMs,
    readiness: result.runtime.readiness?.status === "ready",
    reconciler: result.runtime.reconciler,
    recoveredStatus: normalizedStatus(recovered.status),
    recoveryMs: Math.round(performance.now() - recoveryStartedAt),
    runAttempt: recovered.runAttempt,
    stepCount: recovered.steps.length,
    noDuplicates,
    completed: normalizedStatus(recovered.status) === "COMPLETED",
  };
  result.recovery.runtimeRestart = result.lifecycle.completed;
  expect(result.lifecycle.redisStoppedMaterially, "Redis quiet while stopped");
  expect(result.lifecycle.readiness, "runtime readiness after restart");
  expect(result.lifecycle.reconciler, "reconciler readiness after restart");
  expect(result.lifecycle.noDuplicates, "restart recovery has no duplicates");
  expect(result.lifecycle.completed, "restart recovery completed");
}

async function startManual(workflowId, input) {
  const key = `${gatePrefix}-manual-${randomUUID()}`;
  trackedIdempotencyKeys.add(key);
  const response = await apiRequest(`/workflows/${workflowId}/executions`, {
    method: "POST",
    body: { input, confirmRealEffects: true },
    idempotencyKey: key,
  });
  const id = response.execution.id;
  trackedExecutionIds.add(id);
  return id;
}

async function waitExecution(id, expected) {
  return poll(
    () => apiRequest(`/executions/${id}`),
    (execution) => normalizedStatus(execution?.status) === expected,
    60_000,
    250,
    `execution ${id} ${expected}`,
  );
}

async function waitExecutionDatabase(id, expected, timeoutMs) {
  return poll(
    () => prisma.execution.findUnique({ where: { id } }),
    (execution) => normalizedStatus(execution?.status) === expected,
    timeoutMs,
    250,
    `database execution ${expected}`,
  );
}

async function createDurableExecution(seed, suffix, overrides) {
  const execution = await prisma.execution.create({
    data: {
      organizationId: seed.organizationId,
      workflowId: seed.workflowId,
      workflowVersionId: seed.workflowVersionId,
      correlationId: `${gatePrefix}-${suffix}`,
      executionMode: "REAL",
      inputJson: {
        trigger: {
          input: { text: `urgent ${gatePrefix}`, priority: "urgent" },
        },
        metadata: { gatePrefix, suffix },
      },
      contextJson: {
        trigger: {
          input: { text: `urgent ${gatePrefix}`, priority: "urgent" },
        },
        steps: {},
        metadata: { gatePrefix, suffix },
      },
      startedByUserId: demoUser.id,
      ...overrides,
    },
  });
  trackedExecutionIds.add(execution.id);
  return execution;
}

async function recoverySeed() {
  const workflow = await prisma.workflow.findUniqueOrThrow({
    where: { id: graphWorkflowId },
    include: { activeVersion: true },
  });
  return {
    organizationId: workflow.organizationId,
    workflowId: workflow.id,
    workflowVersionId: workflow.activeVersion.id,
  };
}

function jobPayload(execution, seed) {
  return {
    organizationId: seed.organizationId,
    executionId: execution.id,
    workflowId: seed.workflowId,
    workflowVersionId: seed.workflowVersionId,
    requestId: `${gatePrefix}-${randomUUID()}`,
    correlationId: execution.correlationId,
    enqueuedAt: new Date().toISOString(),
    executionMode: "REAL",
  };
}

function jobOptions(jobId) {
  return {
    jobId,
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: false,
  };
}

async function apiRequest(path, options = {}) {
  const startedAt = performance.now();
  const response = await rawRequest(path, options);
  const elapsed = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`);
  }
  if (options.recordLatency) pushLatency(options.recordLatency, elapsed);
  return response.body;
}

async function rawRequest(path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (!options.unauthenticated && auth) {
    headers.authorization = `Bearer ${auth.token}`;
    headers["x-organization-id"] = auth.organizationId;
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const response = await fetch(`${apiOrigin}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function seedState() {
  const user = await prisma.user.findUnique({ where: { email: demoEmail } });
  const organization = await prisma.organization.findUnique({
    where: { slug: "flowmind-demo" },
  });
  const workflows = await prisma.workflow.findMany({
    where: { id: { in: [graphWorkflowId, approvalWorkflowId] } },
    include: {
      versions: { include: { steps: true } },
    },
    orderBy: { id: "asc" },
  });
  return {
    userId: user?.id,
    organizationId: organization?.id,
    users: user ? 1 : 0,
    organizations: organization ? 1 : 0,
    workflows: workflows.length,
    workflowVersions: workflows.reduce(
      (sum, workflow) => sum + workflow.versions.length,
      0,
    ),
    connections: await prisma.connection.count({
      where: { id: "00000000-0000-4000-8000-000000000201" },
    }),
    notificationRules: await prisma.notificationRule.count({
      where: { id: "00000000-0000-4000-8000-000000000301" },
    }),
    workflowNames: workflows.map((workflow) => workflow.name),
    stepTypes: workflows.flatMap((workflow) =>
      workflow.versions.flatMap((version) =>
        version.steps.map((step) => step.type),
      ),
    ),
  };
}

function seedCounts(state) {
  return {
    users: state.users,
    organizations: state.organizations,
    workflows: state.workflows,
    workflowVersions: state.workflowVersions,
    connections: state.connections,
    notificationRules: state.notificationRules,
  };
}

async function redisCommands() {
  const info = await redis.info("stats");
  const match = /^total_commands_processed:(\d+)$/m.exec(info);
  if (!match) throw new Error("Redis command counter unavailable");
  return Number(match[1]);
}

async function cleanupGateFixtures() {
  const ids = [...trackedExecutionIds];
  if (ids.length) {
    const approvals = await prisma.approvalRequest.findMany({
      where: { executionId: { in: ids } },
      select: { id: true },
    });
    const eventRows = [];
    for (const id of ids) {
      eventRows.push(
        ...(await prisma.internalEvent.findMany({
          where: {
            envelopeJson: { path: ["data", "executionId"], equals: id },
          },
          select: { id: true, rootEventId: true },
        })),
      );
    }
    const eventIds = [...new Set(eventRows.map((row) => row.id))];
    const rootEventIds = [...new Set(eventRows.map((row) => row.rootEventId))];
    const requests = eventIds.length
      ? await prisma.notificationRequest.findMany({
          where: { sourceEventId: { in: eventIds } },
          select: { id: true },
        })
      : [];
    const requestIds = requests.map((row) => row.id);

    if (requestIds.length) {
      await prisma.notificationDelivery.deleteMany({
        where: { notificationRequestId: { in: requestIds } },
      });
      await prisma.notificationRequest.deleteMany({
        where: { id: { in: requestIds } },
      });
    }
    if (eventIds.length) {
      await prisma.internalEventDelivery.deleteMany({
        where: {
          OR: [
            { internalEventId: { in: eventIds } },
            { executionId: { in: ids } },
          ],
        },
      });
    }
    await prisma.executionStepReuse.deleteMany({
      where: {
        OR: [
          { recoveryExecutionId: { in: ids } },
          { sourceExecutionId: { in: ids } },
        ],
      },
    });
    await prisma.stepExecutionAttempt.deleteMany({
      where: { executionId: { in: ids } },
    });
    await prisma.approvalRequest.deleteMany({
      where: { executionId: { in: ids } },
    });
    await prisma.internalRecord.deleteMany({
      where: { executionId: { in: ids } },
    });
    await prisma.deadLetterExecution.deleteMany({
      where: {
        OR: [{ executionId: { in: ids } }, { retryExecutionId: { in: ids } }],
      },
    });
    await prisma.stepExecution.deleteMany({
      where: { executionId: { in: ids } },
    });
    await prisma.execution.updateMany({
      where: { id: { in: ids } },
      data: {
        replayOfExecutionId: null,
        retryOfExecutionId: null,
        parentExecutionId: null,
        rootExecutionId: null,
        parentStepExecutionId: null,
      },
    });
    await prisma.execution.deleteMany({ where: { id: { in: ids } } });
    if (eventIds.length) {
      await prisma.internalEvent.deleteMany({
        where: { id: { in: eventIds } },
      });
    }
    if (rootEventIds.length) {
      await prisma.internalEventChain.deleteMany({
        where: { rootEventId: { in: rootEventIds } },
      });
    }
    const resourceIds = [
      ...ids,
      ...approvals.map((row) => row.id),
      ...eventIds,
      ...requestIds,
    ];
    if (resourceIds.length) {
      await prisma.auditLog.deleteMany({
        where: {
          createdAt: { gte: gateStartedAt },
          resourceId: { in: resourceIds },
        },
      });
    }
  }
  if (trackedIdempotencyKeys.size) {
    await prisma.idempotencyKey.deleteMany({
      where: { key: { in: [...trackedIdempotencyKeys] } },
    });
  }
  if (demoUser) {
    const sessions = await prisma.refreshTokenSession.findMany({
      where: { userId: demoUser.id },
      select: { id: true },
    });
    const createdSessionIds = sessions
      .map((session) => session.id)
      .filter((id) => !initialSessionIds.has(id));
    if (createdSessionIds.length) {
      await prisma.refreshTokenSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }
  }
  const remainingExecutions = ids.length
    ? await prisma.execution.count({ where: { id: { in: ids } } })
    : 0;
  const migrationRows = await prisma.$queryRaw`
    SELECT finished_at, rolled_back_at, logs FROM "_prisma_migrations"
  `;
  result.cleanup = {
    trackedExecutions: ids.length,
    remainingTrackedExecutions: remainingExecutions,
    seedPreserved:
      !seedCompleted ||
      (await prisma.workflow.count({
        where: { id: { in: [graphWorkflowId, approvalWorkflowId] } },
      })) === 2,
    migrationsIntact:
      migrationRows.length === 26 &&
      migrationRows.every(
        (row) =>
          row.finished_at !== null && row.rolled_back_at === null && !row.logs,
      ),
  };
  expect(
    result.cleanup.remainingTrackedExecutions === 0 &&
      result.cleanup.seedPreserved &&
      result.cleanup.migrationsIntact,
    "gate cleanup",
  );
}

function captureRuntimeLogs(stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const safe = redact(line);
      runtimeLogTail.push(safe);
      if (runtimeLogTail.length > 300) runtimeLogTail.shift();
    }
  });
}

function redact(value) {
  let output = String(value);
  for (const secret of [
    process.env.DATABASE_URL,
    process.env.REDIS_URL,
    demoPassword,
  ].filter(Boolean)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(
    /((?:postgres(?:ql)?|rediss?):\/\/)[^\s"']+/gi,
    "$1[REDACTED]",
  );
}

async function runChild(command, args, options) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = `${output}${redact(chunk)}`.slice(-10_000);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${redact(chunk)}`.slice(-10_000);
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
  const exit = await waitForChild(child, options.timeoutMs + 5_000);
  clearTimeout(timeout);
  return { ...exit, output };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child process timeout")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function ensureRuntimeAlive() {
  if (!runtime || runtime.exitCode !== null) {
    throw new Error(
      `demo-runtime exited unexpectedly: ${runtimeLogTail.slice(-5).join(" | ")}`,
    );
  }
}

async function poll(fn, predicate, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await delay(Math.min(intervalMs, deadline - Date.now()));
  }
  throw new Error(`${label} timed out`);
}

async function readRssMiB(pid) {
  const text = await readFile(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error("runtime RSS unavailable");
  return Math.ceil(Number(match[1]) / 1024);
}

async function readCpuTicks(pid) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = text.lastIndexOf(")");
  const fields = text.slice(closing + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

function linearSlopeByX(xValues, yValues) {
  const n = yValues.length;
  const xMean = xValues.reduce((sum, value) => sum + value, 0) / n;
  const yMean = yValues.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (xValues[index] - xMean) * (yValues[index] - yMean);
    denominator += (xValues[index] - xMean) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function pushLatency(name, value) {
  result.latencyMs[name] ??= [];
  result.latencyMs[name].push(Math.round(value));
}

function redisOptions(value) {
  const url = new URL(value);
  const database =
    url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: database,
    tls: {},
    maxRetriesPerRequest: null,
  };
}

function normalizedStatus(value) {
  return String(value ?? "").toUpperCase();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expect(condition, label) {
  if (!condition) throw new Error(`gate assertion failed: ${label}`);
}

function safeError(error) {
  return redact(error instanceof Error ? error.message : String(error)).slice(
    0,
    500,
  );
}

function addBlocker(message) {
  if (!result.blockers.includes(message)) result.blockers.push(message);
}

function progress(stage) {
  process.stdout.write(`GATE_PROGRESS=${stage}\n`);
}

function nonNegativeDelta(before, after) {
  return Math.max(0, after - before);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
