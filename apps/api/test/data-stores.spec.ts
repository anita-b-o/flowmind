import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { OrganizationRole } from "@automation/shared-types";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();

describe("data stores API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    await cleanDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 30_000);

  afterEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("requires editor role and manages stores and records without exposing Prisma entities", async () => {
    const organization = await prisma.organization.create({ data: { name: "Acme", slug: `acme-${Date.now()}` } });
    const otherOrganization = await prisma.organization.create({ data: { name: "Other", slug: `other-${Date.now()}` } });
    const viewer = await addMember(organization.id, OrganizationRole.Viewer, "viewer-ds@example.com");
    const editor = await addMember(organization.id, OrganizationRole.Editor, "editor-ds@example.com");
    const otherEditor = await addMember(otherOrganization.id, OrganizationRole.Editor, "other-editor-ds@example.com");

    await request(app.getHttpServer()).get("/data-stores").set(authHeaders(viewer, organization.id)).expect(403);

    const created = await request(app.getHttpServer())
      .post("/data-stores")
      .set(authHeaders(editor, organization.id))
      .send({ name: "Sessions", description: "temporary workflow sessions" })
      .expect(201);
    expect(created.body).toMatchObject({ name: "Sessions", description: "temporary workflow sessions", recordCount: 0 });
    expect(created.body.organizationId).toBeUndefined();

    const storeId = created.body.id;
    await request(app.getHttpServer()).get(`/data-stores/${storeId}`).set(authHeaders(otherEditor, otherOrganization.id)).expect(404);
    await request(app.getHttpServer()).put(`/data-stores/${storeId}/records/session-1`).set(authHeaders(editor, organization.id)).send({ value: { status: "active" }, metadata: { source: "test" } }).expect(200);
    await request(app.getHttpServer()).put(`/data-stores/${storeId}/records/session-1`).set(authHeaders(editor, organization.id)).send({ value: { status: "updated" }, metadata: { source: "test" }, optimisticConcurrency: true, expectedVersion: 1 }).expect(200);
    expect(await prisma.internalEvent.count({ where: { organizationId: organization.id, eventType: { in: ["DATA_STORE_RECORD_CREATED", "DATA_STORE_RECORD_UPDATED"] } } })).toBe(2);

    const records = await request(app.getHttpServer()).get(`/data-stores/${storeId}/records?page=1&pageSize=10`).set(authHeaders(editor, organization.id)).expect(200);
    expect(records.body.total).toBe(1);
    expect(records.body.items[0]).toMatchObject({ key: "session-1", version: 2, metadata: { source: "test" } });
    expect(records.body.items[0].organizationId).toBeUndefined();

    await request(app.getHttpServer()).get(`/data-stores/${storeId}/records`).set(authHeaders(otherEditor, otherOrganization.id)).expect(404);

    await request(app.getHttpServer()).delete(`/data-stores/${storeId}/records/session-1`).set(authHeaders(editor, organization.id)).expect(200);
    expect(await prisma.internalEvent.count({ where: { organizationId: organization.id, eventType: "DATA_STORE_RECORD_DELETED" } })).toBe(1);
    expect(await prisma.dataStoreRecord.count({ where: { dataStoreId: storeId, deletedAt: null } })).toBe(0);
    await prisma.dataStoreRecord.create({ data: { organizationId: organization.id, dataStoreId: storeId, key: "session-1", valueJson: { status: "recreated" }, metadataJson: {}, version: 1 } });
    expect(await prisma.dataStoreRecord.count({ where: { dataStoreId: storeId, key: "session-1", deletedAt: null } })).toBe(1);

    await request(app.getHttpServer()).delete(`/data-stores/${storeId}`).set(authHeaders(editor, organization.id)).expect(200);
    await request(app.getHttpServer()).post("/data-stores").set(authHeaders(editor, organization.id)).send({ name: "Sessions" }).expect(201);
    expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: "datastore.created" } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: "datastore.record.deleted" } })).toBe(1);
  });
});

async function addMember(organizationId: string, role: OrganizationRole, email: string) {
  const user = await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: "hash" } });
  await prisma.organizationMember.create({ data: { organizationId, userId: user.id, role } });
  return { userId: user.id, accessToken: await jwtSign(user.id, email) };
}

async function jwtSign(userId: string, email: string) {
  const jwt = new JwtService();
  return jwt.signAsync({ sub: userId, email, tokenType: "access", jti: userId }, { secret: process.env.JWT_ACCESS_SECRET });
}

function authHeaders(user: { accessToken: string }, organizationId: string) {
  return { authorization: `Bearer ${user.accessToken}`, "x-organization-id": organizationId };
}

async function cleanDatabase() {
  await prisma.dataStoreRecord.deleteMany();
  await prisma.dataStore.deleteMany();
  await prisma.deadLetterExecution.deleteMany();
  await prisma.internalRecord.deleteMany();
  await prisma.stepExecution.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.internalEventDelivery.deleteMany();
  await prisma.internalEvent.deleteMany();
  await prisma.internalEventChain.deleteMany();
  await prisma.trigger.deleteMany();
  await prisma.workflowStep.deleteMany();
  await prisma.workflow.updateMany({ data: { activeVersionId: null } });
  await prisma.workflowVersion.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.refreshTokenSession.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
