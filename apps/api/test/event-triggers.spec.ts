import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();
describe("event trigger API", () => {
  let app: INestApplication;
  beforeAll(async () => { process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16"; process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16"; await clean(); const ref = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = ref.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.init(); });
  afterAll(async () => { await app?.close(); await clean(); await prisma.$disconnect(); });

  it("enforces RBAC, tenant-scoped filters and lifecycle", async () => {
    const organization = await prisma.organization.create({ data: { name: "Events", slug: `event-api-${Date.now()}` } });
    const other = await prisma.organization.create({ data: { name: "Other", slug: `event-other-${Date.now()}` } });
    const editor = await member(organization.id, "editor", "event-editor@example.com"); const viewer = await member(organization.id, "viewer", "event-viewer@example.com");
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Target", createdByUserId: editor.userId } });
    const foreignStore = await prisma.dataStore.create({ data: { organizationId: other.id, name: "Foreign" } });
    await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers/event`).set(headers(viewer.token, organization.id)).send({ name: "Created", eventType: "DATA_STORE_RECORD_CREATED" }).expect(403);
    await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers/event`).set(headers(editor.token, organization.id)).send({ name: "Foreign", eventType: "DATA_STORE_RECORD_CREATED", filters: { dataStoreId: foreignStore.id } }).expect(404);
    const created = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers/event`).set(headers(editor.token, organization.id)).send({ name: "Completed", eventType: "EXECUTION_COMPLETED", filters: { workflowId: workflow.id, origin: "manual" } }).expect(201);
    expect(created.body).toMatchObject({ type: "event", eventType: "EXECUTION_COMPLETED", enabled: true, filters: { workflowId: workflow.id, origin: "manual" } });
    const listed = await request(app.getHttpServer()).get(`/workflows/${workflow.id}/triggers/event`).set(headers(viewer.token, organization.id)).expect(200); expect(listed.body).toHaveLength(1);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/triggers/${created.body.id}/disable`).set(headers(editor.token, organization.id)).send({}).expect(200);
    await request(app.getHttpServer()).delete(`/workflows/${workflow.id}/triggers/${created.body.id}`).set(headers(editor.token, organization.id)).expect(200);
    expect(await prisma.auditLog.count({ where: { resourceId: created.body.id, action: { startsWith: "event.trigger" } } })).toBe(3);
  });
});
async function member(organizationId: string, role: "editor" | "viewer", email: string) { const user = await prisma.user.create({ data: { email, name: email, passwordHash: "hash" } }); await prisma.organizationMember.create({ data: { organizationId, userId: user.id, role } }); const token = await new JwtService().signAsync({ sub: user.id, email, tokenType: "access", jti: user.id }, { secret: process.env.JWT_ACCESS_SECRET }); return { userId: user.id, token }; }
function headers(token: string, organizationId: string) { return { authorization: `Bearer ${token}`, "x-organization-id": organizationId }; }
async function clean() { await prisma.execution.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.internalEventDelivery.deleteMany(); await prisma.internalEvent.deleteMany(); await prisma.internalEventChain.deleteMany(); await prisma.trigger.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany(); await prisma.dataStoreRecord.deleteMany(); await prisma.dataStore.deleteMany(); await prisma.auditLog.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.refreshTokenSession.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany(); }
