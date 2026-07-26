import { createRequire } from "node:module";

const requireFromApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const { PrismaClient } = requireFromApi("@prisma/client");
const argon2 = requireFromApi("argon2");

if (process.env.FLOWMIND_DEPLOYMENT_PROFILE !== "demo-free") {
  throw new Error(
    "The demo seed only runs with FLOWMIND_DEPLOYMENT_PROFILE=demo-free",
  );
}
const password = process.env.FLOWMIND_DEMO_PASSWORD;
if (!password || password.length < 12) {
  throw new Error("FLOWMIND_DEMO_PASSWORD must contain at least 12 characters");
}

const prisma = new PrismaClient();
const email = (
  process.env.FLOWMIND_DEMO_EMAIL ?? "demo@flowmind.local"
).toLowerCase();

try {
  const passwordHash = await argon2.hash(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name: "FlowMind Demo", passwordHash, status: "ACTIVE" },
    create: { email, name: "FlowMind Demo", passwordHash, status: "ACTIVE" },
  });
  const organization = await prisma.organization.upsert({
    where: { slug: "flowmind-demo" },
    update: { name: "FlowMind Demo" },
    create: { slug: "flowmind-demo", name: "FlowMind Demo" },
  });
  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: { role: "owner", status: "ACTIVE" },
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
      status: "ACTIVE",
    },
  });
  const existingConnection = await prisma.connection.findUnique({
    where: { id: "00000000-0000-4000-8000-000000000201" },
  });
  if (
    existingConnection &&
    existingConnection.organizationId !== organization.id
  ) {
    throw new Error("Seed demo connection belongs to another organization");
  }
  const demoConnection = await prisma.connection.upsert({
    where: { id: "00000000-0000-4000-8000-000000000201" },
    update: {
      name: "Embedded demo email (no external delivery)",
      status: "ACTIVE",
      deletedAt: null,
    },
    create: {
      id: "00000000-0000-4000-8000-000000000201",
      organizationId: organization.id,
      createdByUserId: user.id,
      name: "Embedded demo email (no external delivery)",
      type: "smtp",
      status: "ACTIVE",
      configJson: {
        host: "embedded-demo.invalid",
        port: 587,
        secure: true,
        username: "not-used",
        fromEmail: "demo@flowmind.local",
        fromName: "FlowMind Demo",
      },
    },
  });

  await ensureWorkflow({
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: organization.id,
    userId: user.id,
    name: "Portfolio: Graph v2 + AI demo",
    definition: graphAiDefinition(),
  });
  await ensureWorkflow({
    id: "00000000-0000-4000-8000-000000000102",
    organizationId: organization.id,
    userId: user.id,
    name: "Portfolio: Approval lifecycle",
    definition: approvalDefinition(),
  });
  await prisma.notificationRule.upsert({
    where: { id: "00000000-0000-4000-8000-000000000301" },
    update: {
      enabled: true,
      deletedAt: null,
      connectionId: demoConnection.id,
      recipientConfigJson: { kind: "EMAILS", emails: [email] },
      filtersJson: { workflowId: "00000000-0000-4000-8000-000000000101" },
    },
    create: {
      id: "00000000-0000-4000-8000-000000000301",
      organizationId: organization.id,
      eventType: "EXECUTION_COMPLETED",
      channel: "EMAIL",
      enabled: true,
      connectionId: demoConnection.id,
      recipientConfigJson: { kind: "EMAILS", emails: [email] },
      filtersJson: { workflowId: "00000000-0000-4000-8000-000000000101" },
      templateKey: "workflow.completed",
    },
  });

  console.info("demo.seed.completed", {
    email,
    organizationId: organization.id,
    workflows: 2,
    notificationRule: "EXECUTION_COMPLETED -> embedded fake email",
  });
} finally {
  await prisma.$disconnect();
}

async function ensureWorkflow({
  id,
  organizationId,
  userId,
  name,
  definition,
}) {
  const existing = await prisma.workflow.findUnique({ where: { id } });
  if (existing && existing.organizationId !== organizationId) {
    throw new Error(`Seed workflow ${id} belongs to another organization`);
  }
  const workflow =
    existing ??
    (await prisma.workflow.create({
      data: {
        id,
        organizationId,
        createdByUserId: userId,
        name,
        description:
          "Curated, deterministic workflow for the public portfolio demo.",
      },
    }));
  const versions = await prisma.workflowVersion.findMany({
    where: { workflowId: workflow.id },
    orderBy: { versionNumber: "desc" },
  });
  const definitionKey = canonicalJson(definition);
  let version = versions.find(
    (candidate) => canonicalJson(candidate.definitionJson) === definitionKey,
  );
  if (!version) {
    version = await prisma.workflowVersion.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        createdByUserId: userId,
        versionNumber: (versions[0]?.versionNumber ?? 0) + 1,
        status: "ACTIVE",
        activatedAt: new Date(),
        definitionJson: definition,
        steps: {
          create: [
            row(organizationId, definition.trigger, 0),
            ...definition.steps.map((step, index) =>
              row(organizationId, step, index + 1),
            ),
          ],
        },
      },
    });
  }
  await prisma.workflowVersion.updateMany({
    where: {
      workflowId: workflow.id,
      status: "ACTIVE",
      id: { not: version.id },
    },
    data: { status: "ARCHIVED" },
  });
  if (version.status !== "ACTIVE") {
    version = await prisma.workflowVersion.update({
      where: { id: version.id },
      data: {
        status: "ACTIVE",
        activatedAt: version.activatedAt ?? new Date(),
      },
    });
  }
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { name, status: "ACTIVE", activeVersionId: version.id },
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function row(organizationId, step, position) {
  return {
    organizationId,
    key: step.key,
    name: step.name,
    type: step.type,
    position,
    configJson: step.config,
    timeoutSeconds: step.timeoutSeconds,
  };
}

function graphAiDefinition() {
  const trigger = {
    key: "manual",
    name: "Manual portfolio input",
    type: "manual_trigger",
    config: {},
  };
  const steps = [
    {
      key: "shape",
      name: "Shape input",
      type: "transform",
      config: {
        mode: "OBJECT",
        fields: {
          message: "{{trigger.input.text}}",
          priority: "{{trigger.input.priority}}",
        },
        outputType: "OBJECT",
      },
    },
    {
      key: "route",
      name: "Route priority",
      type: "if",
      config: {
        left: "{{steps.shape.output.priority}}",
        operator: "equals",
        right: "urgent",
        trueStepKey: "urgent_summary",
        falseStepKey: "normal_summary",
      },
    },
    {
      key: "urgent_summary",
      name: "Urgent AI summary",
      type: "ai_summary",
      timeoutSeconds: 30,
      config: { text: "{{steps.shape.output.message}}", max_words: 80 },
    },
    {
      key: "normal_summary",
      name: "Normal AI summary",
      type: "ai_summary",
      timeoutSeconds: 30,
      config: { text: "{{steps.shape.output.message}}", max_words: 80 },
    },
    {
      key: "urgent_record",
      name: "Persist urgent demo result",
      type: "database_record",
      config: {
        collection: "demo_journey",
        data: {
          priority: "{{steps.shape.output.priority}}",
          summary: "{{steps.urgent_summary.output.summary}}",
        },
      },
    },
    {
      key: "normal_record",
      name: "Persist normal demo result",
      type: "database_record",
      config: {
        collection: "demo_journey",
        data: {
          priority: "{{steps.shape.output.priority}}",
          summary: "{{steps.normal_summary.output.summary}}",
        },
      },
    },
  ];
  return {
    workflowDefinitionSchemaVersion: 2,
    expressionMode: "strict",
    trigger,
    steps,
    graph: {
      entryStepKey: "shape",
      edges: [
        { from: "shape", to: "route", kind: "next" },
        { from: "route", to: "urgent_summary", kind: "if_true" },
        { from: "route", to: "normal_summary", kind: "if_false" },
        { from: "urgent_summary", to: "urgent_record", kind: "next" },
        { from: "normal_summary", to: "normal_record", kind: "next" },
      ],
      terminalStepKeys: ["urgent_record", "normal_record"],
    },
    workflowVariables: {},
    environmentVariables: {},
  };
}

function approvalDefinition() {
  const trigger = {
    key: "manual",
    name: "Manual approval request",
    type: "manual_trigger",
    config: {},
  };
  const steps = [
    {
      key: "approval",
      name: "Portfolio approval",
      type: "approval",
      config: {
        title: "Review the portfolio run",
        description: "Approve or reject this deterministic demo execution.",
        allowedRoles: ["owner"],
        assigneePolicy: "ANY_AUTHORIZED_USER",
      },
    },
    {
      key: "approved",
      name: "Approved output",
      type: "transform",
      config: {
        mode: "OBJECT",
        fields: { outcome: "approved" },
        outputType: "OBJECT",
      },
    },
    {
      key: "rejected",
      name: "Rejected output",
      type: "transform",
      config: {
        mode: "OBJECT",
        fields: { outcome: "rejected" },
        outputType: "OBJECT",
      },
    },
    {
      key: "expired",
      name: "Expired output",
      type: "transform",
      config: {
        mode: "OBJECT",
        fields: { outcome: "expired" },
        outputType: "OBJECT",
      },
    },
  ];
  return {
    workflowDefinitionSchemaVersion: 2,
    expressionMode: "strict",
    trigger,
    steps,
    graph: {
      entryStepKey: "approval",
      edges: [
        { from: "approval", to: "approved", kind: "approval_approved" },
        { from: "approval", to: "rejected", kind: "approval_rejected" },
        { from: "approval", to: "expired", kind: "approval_expired" },
      ],
      terminalStepKeys: ["approved", "rejected", "expired"],
    },
    workflowVariables: {},
    environmentVariables: {},
  };
}
