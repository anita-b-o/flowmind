import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

const prisma = new PrismaClient();
let httpServer: any;

describe("auth refresh sessions", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    process.env.JWT_ACCESS_EXPIRES_IN = "15m";
    process.env.JWT_REFRESH_EXPIRES_IN = "30d";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.CORS_ORIGIN = "http://localhost:3000";
    process.env.SESSION_IP_HASH_PEPPER = "test-session-ip-pepper";
    process.env.AUTH_ORIGIN_REQUIRED = "false";

    await cleanDatabase();
    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    httpServer = app.getHttpServer();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    process.env.NODE_ENV = "test";
    process.env.AUTH_ORIGIN_REQUIRED = "false";
  });

  it("login establishes an HttpOnly /auth cookie and does not return refreshToken", async () => {
    await seedUser("login@example.com");
    const response = await request(app.getHttpServer()).post("/auth/login").send(credentials("login@example.com")).expect(201);

    expect(response.body.accessToken).toBeDefined();
    expect(response.body.refreshToken).toBeUndefined();
    const cookie = setCookie(response);
    expect(cookie).toContain("refresh_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/auth");
  });

  it("production cookies include Secure", async () => {
    await seedUser("secure@example.com");
    process.env.NODE_ENV = "production";
    const response = await request(app.getHttpServer()).post("/auth/login").send(credentials("secure@example.com")).expect(201);
    expect(setCookie(response)).toContain("Secure");
  });

  it("register establishes a cookie and does not return refreshToken", async () => {
    const response = await register("register@example.com");
    expect(response.body.accessToken).toBeDefined();
    expect(response.body.user.email).toBe("register@example.com");
    expect(response.body.defaultOrganizationId).toBeDefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(setCookie(response)).toContain("refresh_token=");
  });

  it("refresh returns a new access token, replaces cookie, revokes old session, and rejects old token reuse", async () => {
    await seedUser("rotate@example.com");
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post("/auth/login").send(credentials("rotate@example.com")).expect(201);
    const oldCookie = setCookie(login);
    const oldSession = await firstSession();

    const refresh = await agent.post("/auth/refresh").set("Origin", "http://localhost:3000").expect(200);
    expect(refresh.body.accessToken).toBeDefined();
    expect(refresh.body.accessToken).not.toBe(login.body.accessToken);
    expect(setCookie(refresh)).not.toEqual(oldCookie);

    const revokedOld = await prisma.refreshTokenSession.findUniqueOrThrow({ where: { id: oldSession.id } });
    expect(revokedOld.revokedAt).toBeTruthy();
    expect(revokedOld.replacedBySessionId).toBeTruthy();

    await request(app.getHttpServer()).post("/auth/refresh").set("Cookie", oldCookie).set("Origin", "http://localhost:3000").expect(401);
    const familyActive = await prisma.refreshTokenSession.count({ where: { tokenFamily: oldSession.tokenFamily, revokedAt: null } });
    expect(familyActive).toBe(0);
  });

  it("logout revokes the session and is idempotent without a cookie", async () => {
    await seedUser("logout@example.com");
    const agent = request.agent(app.getHttpServer());
    await agent.post("/auth/login").send(credentials("logout@example.com")).expect(201);
    await agent.post("/auth/logout").set("Origin", "http://localhost:3000").expect(204);
    expect(await prisma.refreshTokenSession.count({ where: { revokedAt: null } })).toBe(0);
    await request(app.getHttpServer()).post("/auth/logout").set("Origin", "http://localhost:3000").expect(204);
  });

  it("logout-all revokes all sessions", async () => {
    await seedUser("all@example.com");
    const first = await request(app.getHttpServer()).post("/auth/login").send(credentials("all@example.com")).expect(201);
    await request(app.getHttpServer()).post("/auth/login").send(credentials("all@example.com")).expect(201);

    await request(app.getHttpServer())
      .post("/auth/logout-all")
      .set("Authorization", `Bearer ${first.body.accessToken}`)
      .set("Origin", "http://localhost:3000")
      .expect(204);

    expect(await prisma.refreshTokenSession.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("/auth/me returns the user and organizations", async () => {
    const registered = await register("me@example.com");
    const response = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${registered.body.accessToken}`)
      .expect(200);

    expect(response.body.user.email).toBe("me@example.com");
    expect(response.body.organizations).toHaveLength(1);
    expect(response.body.organizations[0]).toMatchObject({ name: "Acme", role: "owner" });
  });

  it("does not allow users to delete another user's session", async () => {
    const userA = await register("user-a@example.com");
    await register("user-b@example.com");
    const foreignSession = await prisma.refreshTokenSession.findFirstOrThrow({ where: { user: { email: "user-b@example.com" } } });

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${foreignSession.id}`)
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .expect(404);
  });

  it("rejects invalid Origin for cookie-backed mutations", async () => {
    await seedUser("origin@example.com");
    const agent = request.agent(app.getHttpServer());
    await agent.post("/auth/login").send(credentials("origin@example.com")).expect(201);
    await agent.post("/auth/refresh").set("Origin", "https://evil.example").expect(403);
  });

  it("access guard rejects refresh tokens used as Bearer", async () => {
    const jwt = new JwtService();
    const refreshToken = await jwt.signAsync(
      { sub: "user-id", sessionId: "session-id", tokenFamily: "family", tokenType: "refresh" },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: "15m" }
    );
    await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${refreshToken}`).expect(401);
  });
});

function credentials(email: string) {
  return { email, password: "password123" };
}

async function seedUser(email: string) {
  await register(email);
  await prisma.refreshTokenSession.deleteMany();
}

function register(email: string) {
  return request(httpServer).post("/auth/register").send({ email, name: email.split("@")[0], password: "password123", organizationName: "Acme" }).expect(201);
}

function setCookie(response: request.Response) {
  const cookie = response.headers["set-cookie"];
  return Array.isArray(cookie) ? cookie[0] : cookie;
}

async function firstSession() {
  return prisma.refreshTokenSession.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
}

async function cleanDatabase() {
  await prisma.internalRecord.deleteMany();
  await prisma.stepExecution.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.trigger.deleteMany();
  await prisma.workflowStep.deleteMany();
  await prisma.workflow.updateMany({ data: { activeVersionId: null } });
  await prisma.workflowVersion.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.refreshTokenSession.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
