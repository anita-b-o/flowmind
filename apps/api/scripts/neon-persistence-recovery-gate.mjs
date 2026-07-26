import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const prefix = `flowmind-neon-gate-${Date.now()}-${randomUUID().slice(0, 8)}`;
const fixtures = {
  userIds: [],
  organizationIds: [],
};
const results = {
  executionPersistence: false,
  stepExecution: false,
  stepExecutionAttempt: false,
  lease: false,
  dataStore: false,
  approval: false,
  replayLineage: false,
  recovery: false,
  multiTenant: false,
  cleanup: false,
  migrationsIntact: false,
};

let failure;
try {
  await runGate();
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanupFixtures();
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  await prisma.$disconnect().catch(() => undefined);
}

if (failure) {
  process.stderr.write(
    "neon-persistence-recovery-gate: failed; details redacted\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ prefix, ...results })}\n`);
}

async function runGate() {
  const tenantA = await createTenant("a");
  const tenantB = await createTenant("b");

  const lifecycle = await prisma.execution.create({
    data: executionData(tenantA, {
      correlationId: `${prefix}-lifecycle`,
      status: "QUEUED",
    }),
  });
  const created = await prisma.execution.findFirst({
    where: { id: lifecycle.id, organizationId: tenantA.organization.id },
  });
  expect(
    created?.status === "QUEUED" &&
      created.correlationId === `${prefix}-lifecycle`,
    "execution create/read",
  );
  await prisma.execution.update({
    where: { id: lifecycle.id },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      runAttempt: { increment: 1 },
    },
  });
  await prisma.execution.update({
    where: { id: lifecycle.id },
    data: { status: "RETRYING", waitReason: "retry_backoff" },
  });
  const updated = await prisma.execution.findUniqueOrThrow({
    where: { id: lifecycle.id },
  });
  expect(
    updated.status === "RETRYING" &&
      updated.startedAt instanceof Date &&
      updated.runAttempt === 1 &&
      updated.waitReason === "retry_backoff",
    "execution lifecycle update",
  );
  results.executionPersistence = true;

  const persistedStep = await prisma.stepExecution.create({
    data: {
      organizationId: tenantA.organization.id,
      executionId: lifecycle.id,
      workflowStepId: tenantA.steps.persist.id,
      stepKey: "persist",
      stepType: "transform",
      status: "COMPLETED",
      attempt: 1,
      attemptCount: 1,
      maxAttempts: 2,
      effectKey: `${prefix}:persist`,
      effectStatus: "succeeded",
      inputJson: { prefix },
      outputJson: { durable: true },
      executionPath: "root/gate[0]",
      iterationIndex: 0,
      startedAt: new Date(Date.now() - 10),
      completedAt: new Date(),
      durationMs: 10,
    },
  });
  const stepRead = await prisma.stepExecution.findUniqueOrThrow({
    where: { id: persistedStep.id },
  });
  expect(
    stepRead.status === "COMPLETED" &&
      stepRead.executionPath === "root/gate[0]" &&
      stepRead.iterationIndex === 0 &&
      stepRead.startedAt instanceof Date &&
      stepRead.completedAt instanceof Date,
    "step execution durability",
  );
  results.stepExecution = true;

  const attempt = await prisma.stepExecutionAttempt.create({
    data: {
      organizationId: tenantA.organization.id,
      executionId: lifecycle.id,
      stepExecutionId: persistedStep.id,
      attempt: 1,
      status: "COMPLETED",
      effectStatus: "succeeded",
      errorCategory: null,
      errorCodeSafe: null,
      errorMessageSafe: null,
      startedAt: stepRead.startedAt,
      completedAt: stepRead.completedAt,
      durationMs: 10,
    },
  });
  const attemptRead = await prisma.stepExecutionAttempt.findUniqueOrThrow({
    where: {
      stepExecutionId_attempt: {
        stepExecutionId: persistedStep.id,
        attempt: 1,
      },
    },
  });
  expect(
    attemptRead.id === attempt.id &&
      attemptRead.executionId === lifecycle.id &&
      attemptRead.organizationId === tenantA.organization.id &&
      attemptRead.errorMessageSafe === null,
    "step execution attempt relation",
  );
  results.stepExecutionAttempt = true;

  const leaseExecution = await prisma.execution.create({
    data: executionData(tenantA, {
      correlationId: `${prefix}-lease`,
      status: "QUEUED",
    }),
  });
  expect(
    await acquireLease(
      leaseExecution.id,
      tenantA.organization.id,
      `${prefix}-worker-a`,
    ),
    "lease acquisition",
  );
  expect(
    !(await acquireLease(
      leaseExecution.id,
      tenantA.organization.id,
      `${prefix}-worker-b`,
    )),
    "lease conflict",
  );
  await releaseLease(leaseExecution.id, `${prefix}-worker-a`);
  expect(
    await acquireLease(
      leaseExecution.id,
      tenantA.organization.id,
      `${prefix}-worker-b`,
    ),
    "lease after release",
  );
  await prisma.execution.update({
    where: { id: leaseExecution.id },
    data: { lockedUntil: new Date(Date.now() - 1) },
  });
  expect(
    await acquireLease(
      leaseExecution.id,
      tenantA.organization.id,
      `${prefix}-worker-a`,
    ),
    "lease after deterministic expiry",
  );
  await releaseLease(leaseExecution.id, `${prefix}-worker-a`);
  const released = await prisma.execution.findUniqueOrThrow({
    where: { id: leaseExecution.id },
  });
  expect(
    released.lockedBy === null && released.lockedUntil === null,
    "lease release",
  );
  results.lease = true;

  const approvalStep = await prisma.stepExecution.create({
    data: {
      organizationId: tenantA.organization.id,
      executionId: lifecycle.id,
      workflowStepId: tenantA.steps.approval.id,
      stepKey: "approval",
      stepType: "approval",
      status: "RETRYING",
      attemptCount: 1,
      maxAttempts: 1,
      effectKey: `${prefix}:approval`,
      effectStatus: "approval_waiting",
      inputJson: { prefix },
      executionPath: "root",
    },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: tenantA.organization.id,
      executionId: lifecycle.id,
      stepExecutionId: approvalStep.id,
      workflowId: tenantA.workflow.id,
      workflowVersionId: tenantA.version.id,
      stepKey: "approval",
      status: "PENDING",
      title: prefix,
      assigneePolicy: "ANY_AUTHORIZED_USER",
      allowedRoles: ["owner"],
    },
  });
  const approvalRead = await prisma.approvalRequest.findUniqueOrThrow({
    where: { id: approval.id },
    include: { stepExecution: true },
  });
  expect(
    approvalRead.status === "PENDING" &&
      approvalRead.stepExecution.id === approvalStep.id &&
      approvalRead.stepExecution.effectStatus === "approval_waiting",
    "approval durability",
  );
  results.approval = true;

  const storeA = await createStoreRecord(tenantA, "shared-key");
  const storeB = await createStoreRecord(tenantB, "shared-key");
  const recordA = await prisma.dataStoreRecord.findFirstOrThrow({
    where: {
      id: storeA.record.id,
      organizationId: tenantA.organization.id,
      dataStoreId: storeA.store.id,
    },
  });
  expect(
    recordA.version === 1 &&
      recordA.key === "shared-key" &&
      recordA.deletedAt === null,
    "data store durability",
  );
  results.dataStore = true;

  const original = await prisma.execution.create({
    data: executionData(tenantA, {
      correlationId: `${prefix}-original`,
      status: "FAILED",
      completedAt: new Date(),
    }),
  });
  const replay = await prisma.execution.create({
    data: executionData(tenantA, {
      correlationId: `${prefix}-replay`,
      status: "QUEUED",
      replayOfExecutionId: original.id,
      replayMode: "RETRY_FROM_FAILURE",
      replayFromStepKey: "persist",
      replayFromExecutionPath: "root/gate[0]",
    }),
  });
  await prisma.executionStepReuse.create({
    data: {
      organizationId: tenantA.organization.id,
      recoveryExecutionId: replay.id,
      sourceExecutionId: original.id,
      sourceStepExecutionId: persistedStep.id,
      stepKey: persistedStep.stepKey,
      stepType: persistedStep.stepType,
      executionPath: persistedStep.executionPath,
      iterationIndex: persistedStep.iterationIndex,
      status: persistedStep.status,
    },
  });
  const replayRead = await prisma.execution.findUniqueOrThrow({
    where: { id: replay.id },
    include: { recoveryStepReuses: true },
  });
  expect(
    replayRead.replayOfExecutionId === original.id &&
      replayRead.parentExecutionId === null &&
      replayRead.replayMode === "RETRY_FROM_FAILURE" &&
      replayRead.recoveryStepReuses.length === 1,
    "replay lineage",
  );
  results.replayLineage = true;

  const recoveryExecution = await prisma.execution.create({
    data: executionData(tenantA, {
      correlationId: `${prefix}-recoverable`,
      status: "RUNNING",
      lockedBy: `${prefix}-dead-worker`,
      lockedUntil: new Date(Date.now() - 1_000),
      lastHeartbeatAt: new Date(Date.now() - 2_000),
    }),
  });
  await prisma.stepExecution.create({
    data: {
      organizationId: tenantA.organization.id,
      executionId: recoveryExecution.id,
      workflowStepId: tenantA.steps.recovery.id,
      stepKey: "recovery",
      stepType: "transform",
      status: "RUNNING",
      attemptCount: 1,
      maxAttempts: 2,
      workerId: `${prefix}-dead-worker`,
      inputJson: { prefix },
      executionPath: "root",
      startedAt: new Date(Date.now() - 2_000),
    },
  });
  const recoverable = await prisma.execution.findFirst({
    where: {
      id: recoveryExecution.id,
      organizationId: tenantA.organization.id,
      status: "RUNNING",
      lockedUntil: { lt: new Date() },
      steps: { some: { status: "RUNNING" } },
    },
    include: { steps: true },
  });
  expect(
    recoverable?.id === recoveryExecution.id &&
      recoverable.steps.some((step) => step.status === "RUNNING"),
    "reconciler recovery predicate",
  );
  results.recovery = true;

  const tenantBExecution = await prisma.execution.create({
    data: executionData(tenantB, {
      correlationId: `${prefix}-tenant-b`,
      status: "QUEUED",
    }),
  });
  const crossTenantExecution = await prisma.execution.findFirst({
    where: {
      id: lifecycle.id,
      organizationId: tenantB.organization.id,
    },
  });
  const crossTenantApproval = await prisma.approvalRequest.findFirst({
    where: {
      id: approval.id,
      organizationId: tenantB.organization.id,
    },
  });
  const tenantACount = await prisma.dataStoreRecord.count({
    where: {
      organizationId: tenantA.organization.id,
      key: "shared-key",
    },
  });
  const tenantBCount = await prisma.dataStoreRecord.count({
    where: {
      organizationId: tenantB.organization.id,
      key: "shared-key",
    },
  });
  expect(
    crossTenantExecution === null &&
      crossTenantApproval === null &&
      tenantACount === 1 &&
      tenantBCount === 1 &&
      tenantBExecution.organizationId === tenantB.organization.id &&
      storeB.record.organizationId === tenantB.organization.id,
    "multi-tenant isolation",
  );
  results.multiTenant = true;
}

async function createTenant(suffix) {
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${suffix}@example.invalid`,
      name: `${prefix}-${suffix}`,
      passwordHash: "gate-fixture-not-a-real-password",
    },
  });
  fixtures.userIds.push(user.id);
  const organization = await prisma.organization.create({
    data: {
      name: `${prefix}-${suffix}`,
      slug: `${prefix}-${suffix}`,
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  fixtures.organizationIds.push(organization.id);
  const workflow = await prisma.workflow.create({
    data: {
      organizationId: organization.id,
      name: `${prefix}-${suffix}`,
      status: "ACTIVE",
      createdByUserId: user.id,
    },
  });
  const version = await prisma.workflowVersion.create({
    data: {
      organizationId: organization.id,
      workflowId: workflow.id,
      versionNumber: 1,
      status: "ACTIVE",
      activatedAt: new Date(),
      createdByUserId: user.id,
      definitionJson: { prefix, suffix },
      steps: {
        create: [
          workflowStep(organization.id, "persist", "transform", 1),
          workflowStep(organization.id, "approval", "approval", 2),
          workflowStep(organization.id, "recovery", "transform", 3),
        ],
      },
    },
    include: { steps: true },
  });
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { activeVersionId: version.id },
  });
  return {
    user,
    organization,
    workflow,
    version,
    steps: Object.fromEntries(version.steps.map((step) => [step.key, step])),
  };
}

function executionData(tenant, overrides) {
  return {
    organizationId: tenant.organization.id,
    workflowId: tenant.workflow.id,
    workflowVersionId: tenant.version.id,
    executionMode: "REAL",
    inputJson: { prefix },
    contextJson: {
      recoveryCheckpoint: { schemaVersion: 1, complete: true },
    },
    startedByUserId: tenant.user.id,
    ...overrides,
  };
}

async function createStoreRecord(tenant, key) {
  const store = await prisma.dataStore.create({
    data: {
      organizationId: tenant.organization.id,
      name: `${prefix}-${key}`,
    },
  });
  const record = await prisma.dataStoreRecord.create({
    data: {
      organizationId: tenant.organization.id,
      dataStoreId: store.id,
      key,
      valueJson: { prefix, tenant: tenant.organization.id },
      metadataJson: { gate: prefix },
    },
  });
  return { store, record };
}

async function acquireLease(executionId, organizationId, workerId) {
  const now = new Date();
  const result = await prisma.execution.updateMany({
    where: {
      id: executionId,
      organizationId,
      status: { in: ["PENDING", "QUEUED", "RETRYING", "RUNNING"] },
      OR: [
        { lockedBy: null },
        { lockedUntil: { lt: now } },
        { lockedBy: workerId },
      ],
    },
    data: {
      lockedBy: workerId,
      lockedUntil: new Date(now.getTime() + 60_000),
      lastHeartbeatAt: now,
      status: "RUNNING",
      runAttempt: { increment: 1 },
    },
  });
  return result.count === 1;
}

async function releaseLease(executionId, workerId) {
  const result = await prisma.execution.updateMany({
    where: { id: executionId, lockedBy: workerId },
    data: { lockedBy: null, lockedUntil: null },
  });
  expect(result.count === 1, "lease release update");
}

async function cleanupFixtures() {
  const organizationIds = fixtures.organizationIds;
  if (organizationIds.length) {
    const organizationWhere = { organizationId: { in: organizationIds } };
    await prisma.executionStepReuse.deleteMany({ where: organizationWhere });
    await prisma.stepExecutionAttempt.deleteMany({ where: organizationWhere });
    await prisma.approvalRequest.deleteMany({ where: organizationWhere });
    await prisma.stepExecution.deleteMany({ where: organizationWhere });
    await prisma.dataStoreRecord.deleteMany({ where: organizationWhere });
    await prisma.dataStore.deleteMany({ where: organizationWhere });
    await prisma.execution.updateMany({
      where: organizationWhere,
      data: {
        replayOfExecutionId: null,
        retryOfExecutionId: null,
        parentExecutionId: null,
        rootExecutionId: null,
        parentStepExecutionId: null,
      },
    });
    await prisma.execution.deleteMany({ where: organizationWhere });
    await prisma.workflow.updateMany({
      where: organizationWhere,
      data: { activeVersionId: null },
    });
    await prisma.workflowStep.deleteMany({ where: organizationWhere });
    await prisma.workflowVersion.deleteMany({ where: organizationWhere });
    await prisma.workflow.deleteMany({ where: organizationWhere });
    await prisma.organizationMember.deleteMany({ where: organizationWhere });
    await prisma.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });
  }
  if (fixtures.userIds.length) {
    await prisma.user.deleteMany({
      where: { id: { in: fixtures.userIds } },
    });
  }

  const remainingOrganizations = await prisma.organization.count({
    where: { id: { in: organizationIds } },
  });
  const remainingUsers = await prisma.user.count({
    where: { id: { in: fixtures.userIds } },
  });
  const remainingPrefixedOrganizations = await prisma.organization.count({
    where: { slug: { startsWith: prefix } },
  });
  const remainingPrefixedUsers = await prisma.user.count({
    where: { email: { startsWith: prefix } },
  });
  expect(
    remainingOrganizations === 0 &&
      remainingUsers === 0 &&
      remainingPrefixedOrganizations === 0 &&
      remainingPrefixedUsers === 0,
    "fixture cleanup",
  );
  results.cleanup = true;

  const migrationRows = await prisma.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at, logs
    FROM "_prisma_migrations"
  `;
  expect(
    migrationRows.length === 26 &&
      migrationRows.every(
        (row) =>
          row.finished_at !== null && row.rolled_back_at === null && !row.logs,
      ),
    "migration history intact after cleanup",
  );
  results.migrationsIntact = true;
}

function workflowStep(organizationId, key, type, position) {
  return {
    organizationId,
    key,
    name: key,
    type,
    position,
    configJson: { prefix },
  };
}

function expect(condition, label) {
  if (!condition) throw new Error(`gate assertion failed: ${label}`);
}
