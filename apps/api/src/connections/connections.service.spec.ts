import { ConnectionStatus, ConnectionType, HttpAuthScheme, OrganizationRole } from "@automation/shared-types";
import { ConnectionsService } from "./connections.service";
import nodemailer from "nodemailer";

jest.mock("nodemailer", () => ({
  createTransport: jest.fn(() => ({ verify: jest.fn(async () => true) }))
}));

describe("ConnectionsService", () => {
  it("creates an HTTP bearer connection without persisting plaintext", async () => {
    const prisma = prismaMock();
    const service = serviceWith(prisma);

    const result = await service.create("org-1", "user-1", {
      type: ConnectionType.Http,
      authScheme: HttpAuthScheme.BearerToken,
      name: "API",
      secretValue: "bearer-secret"
    } as any);

    expect(result.type).toBe(ConnectionType.Http);
    expect(result.maskedCredential).toContain("********cret");
    expect(prisma.secret.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ encryptedValue: "encrypted:bearer-secret" })
    }));
    expect(JSON.stringify(prisma.connection.create.mock.calls)).not.toContain("bearer-secret");
  });

  it.each([
    [HttpAuthScheme.BasicAuth, { username: "ada", secretValue: "basic-pass" }, "ada: ********pass"],
    [HttpAuthScheme.ApiKey, { authLocation: "HEADER", authName: "X-Api-Key", secretValue: "api-secret" }, "X-Api-Key: ********cret"],
    [HttpAuthScheme.CustomHeaders, { secretHeaders: { "X-Api-Key": "custom-secret" } }, "X-Api-Key: ********cret"]
  ])("creates HTTP %s with only safe previews", async (authScheme, fields, preview) => {
    const prisma = prismaMock();
    const service = serviceWith(prisma);

    const result = await service.create("org-1", "user-1", {
      type: ConnectionType.Http,
      authScheme,
      name: "API",
      ...fields
    } as any);

    expect(result.maskedCredential).toContain(preview);
    expect(JSON.stringify(result)).not.toContain("api-secret");
    expect(JSON.stringify(result)).not.toContain("basic-pass");
    expect(JSON.stringify(result)).not.toContain("custom-secret");
  });

  it("rejects fields and headers that do not belong to the selected HTTP scheme", async () => {
    const service = serviceWith(prismaMock());

    await expect(
      service.create("org-1", "user-1", {
        type: ConnectionType.Http,
        authScheme: HttpAuthScheme.BearerToken,
        name: "API",
        authName: "Authorization",
        secretValue: "token"
      } as any)
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "INVALID_CONNECTION_CONFIG" }) });

    await expect(
      service.create("org-1", "user-1", {
        type: ConnectionType.Http,
        authScheme: HttpAuthScheme.CustomHeaders,
        name: "API",
        secretHeaders: { "Transfer-Encoding": "chunked" }
      } as any)
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "INVALID_CONNECTION_CONFIG" }) });
  });

  it("updates metadata without rotating or accepting secret payloads", async () => {
    const prisma = prismaMock({
      connection: { ...connectionRow(), configJson: { authScheme: "API_KEY", authLocation: "HEADER", authName: "X-Api-Key", secretPreview: "********cret" } }
    });
    const service = serviceWith(prisma);

    const result = await service.update("org-1", "user-1", "conn-1", { name: "Renamed", additionalHeaders: { "X-Public": "ok" } } as any);

    expect(result.name).toBe("Renamed");
    expect(prisma.secret.create).not.toHaveBeenCalled();
    await expect(service.update("org-1", "user-1", "conn-1", { secretValue: "new-secret" } as any)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "INVALID_CONNECTION_CONFIG" })
    });
  });

  it("rotates by revoking the active secret and creating a new version", async () => {
    const prisma = prismaMock({
      connection: { ...connectionRow(), configJson: { authScheme: "BEARER" } }
    });
    const service = serviceWith(prisma);

    await service.rotate("org-1", "user-1", "conn-1", { secretValue: "next-token" });

    expect(prisma.secret.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ connectionId: "conn-1", status: "ACTIVE" }),
      data: expect.objectContaining({ status: "REVOKED" })
    }));
    expect(prisma.secret.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ encryptedValue: "encrypted:next-token", status: "ACTIVE" })
    }));
  });

  it("disables and enables without deleting secrets", async () => {
    const prisma = prismaMock();
    const service = serviceWith(prisma);

    await service.disable("org-1", "user-1", "conn-1");
    await service.enable("org-1", "user-1", "conn-1");

    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ConnectionStatus.Disabled }) }));
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ConnectionStatus.Active }) }));
    expect(prisma.secret.updateMany).not.toHaveBeenCalled();
  });

  it("prevents deleting a connection used by an active workflow version", async () => {
    const prisma = prismaMock({
      versions: [{ id: "version-1", versionNumber: 1, workflow: { id: "wf-1", name: "Workflow" }, steps: [{ key: "http", name: "HTTP", configJson: { connectionId: "conn-1" } }] }]
    });
    const service = serviceWith(prisma, OrganizationRole.Owner);

    await expect(service.delete("org-1", "user-1", "conn-1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "CONNECTION_IN_USE" }) });
  });

  it("prevents deleting a connection referenced by draft rows or definition snapshots", async () => {
    const prisma = prismaMock({
      versions: [
        {
          id: "version-1",
          versionNumber: 1,
          status: "DRAFT",
          workflow: { id: "wf-1", name: "Workflow" },
          steps: [{ key: "http", name: "HTTP", configJson: { connectionId: "conn-other" } }],
          definitionJson: { steps: [{ key: "email", name: "Email", config: { connectionId: "conn-1" } }] }
        }
      ]
    });
    const service = serviceWith(prisma, OrganizationRole.Owner);

    await expect(service.delete("org-1", "user-1", "conn-1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "CONNECTION_IN_USE" }) });
  });

  it("soft deletes unused connections for owners", async () => {
    const prisma = prismaMock({ versions: [] });
    const service = serviceWith(prisma, OrganizationRole.Owner);

    await expect(service.delete("org-1", "user-1", "conn-1")).resolves.toBeNull();
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ConnectionStatus.Deleted }) }));
    expect(prisma.secret.updateMany).toHaveBeenCalled();
  });

  it("tests HTTP using decrypted credentials and stores only safe test metadata", async () => {
    const prisma = prismaMock({ connection: { ...connectionRow(), configJson: { authScheme: "BEARER", baseUrl: "https://api.example.test" } } });
    const testClient = { request: jest.fn(async () => ({ ok: true, status: 200, durationMs: 12 })) };
    const service = serviceWith(prisma, OrganizationRole.Admin, testClient);

    const result = await service.test("org-1", "user-1", "conn-1", { url: "/health" });

    expect(result).toEqual(expect.objectContaining({ success: true, status: 200 }));
    expect(testClient.request).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer plaintext" })
    }));
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastTestStatus: "SUCCESS", lastTestStatusCode: 200 })
    }));
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain("plaintext");
  });

  it("tests API key query connections by preserving existing query params", async () => {
    const prisma = prismaMock({ connection: { ...connectionRow(), configJson: { authScheme: "API_KEY", authLocation: "QUERY", authName: "api_key", baseUrl: "https://api.example.test?existing=1" } } });
    const testClient = { request: jest.fn(async (_input: any) => ({ ok: true, status: 200, durationMs: 8 })) };
    const service = serviceWith(prisma, OrganizationRole.Admin, testClient);

    await service.test("org-1", "user-1", "conn-1", { url: "/health?mode=ready" });

    const firstRequest = testClient.request.mock.calls[0]?.[0] as any;
    expect(firstRequest).toBeDefined();
    const requestUrl = new URL(firstRequest.url);
    expect(requestUrl.searchParams.get("existing")).toBe("1");
    expect(requestUrl.searchParams.get("mode")).toBe("ready");
    expect(requestUrl.searchParams.get("api_key")).toBe("plaintext");
    expect(firstRequest.headers).not.toHaveProperty("api_key");
  });

  it("maps legacy HTTP API key configs without authScheme", async () => {
    const prisma = prismaMock({ connection: { ...connectionRow(), configJson: { authLocation: "HEADER", authName: "X-Legacy-Key" } } });
    const service = serviceWith(prisma);

    const result = await service.detail("org-1", "user-1", "conn-1");

    expect(result.type).toBe(ConnectionType.Http);
    expect(result.authScheme).toBe(HttpAuthScheme.ApiKey);
    expect(result.maskedCredential).toContain("X-Legacy-Key");
  });

  it("tests SMTP with nodemailer verify and stores safe metadata", async () => {
    const prisma = prismaMock({ connection: { ...connectionRow(), type: "smtp", configJson: { host: "smtp.example.test", port: 587, secure: false, username: "mailer", fromEmail: "ops@example.test" } } });
    const service = serviceWith(prisma);

    await expect(service.test("org-1", "user-1", "conn-1", {})).resolves.toMatchObject({ success: true });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.test", port: 587, auth: { user: "mailer", pass: "plaintext" } }));
    expect(JSON.stringify(prisma.connection.update.mock.calls)).not.toContain("plaintext");
  });
});

function serviceWith(prisma: any, role: OrganizationRole = OrganizationRole.Admin, testClient = { request: jest.fn() }) {
  prisma.organizationMember.findFirst.mockResolvedValue({ role });
  return new ConnectionsService(
    prisma,
    {
      encrypt: (plaintext: string) => ({ encryptedValue: `encrypted:${plaintext}`, encryptionVersion: 1, keyId: "primary" }),
      decrypt: () => "plaintext"
    } as any,
    testClient as any,
    { record: jest.fn((input, tx) => (tx ?? prisma).auditLog.create({ data: { metadataJson: input.metadata ?? {} } })) } as any
  );
}

function prismaMock(overrides: { connection?: any; versions?: any[] } = {}) {
  const connection = overrides.connection ?? connectionRow();
  const prisma: any = {
    organizationMember: { findFirst: jest.fn(async () => ({ role: OrganizationRole.Admin })) },
    connection: {
      findFirst: jest.fn(async () => connection),
      findMany: jest.fn(async () => [connection]),
      create: jest.fn(async ({ data }) => ({ ...connection, ...data, id: "conn-1", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })),
      update: jest.fn(async ({ data }) => ({ ...connection, ...data, updatedAt: new Date("2026-01-02") }))
    },
    secret: {
      findFirst: jest.fn(async () => ({ encryptedValue: "encrypted:plaintext" })),
      create: jest.fn(async ({ data }) => ({ id: "secret-1", ...data })),
      updateMany: jest.fn(async () => ({ count: 1 }))
    },
    workflowVersion: {
      findMany: jest.fn(async () =>
        (overrides.versions ?? []).map((version: any) => ({
          definitionJson: {},
          ...version
        }))
      )
    },
    auditLog: { create: jest.fn(async ({ data }) => ({ id: "audit-1", ...data })) },
    $transaction: jest.fn(async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input)))
  };
  return prisma;
}

function connectionRow() {
  return {
    id: "conn-1",
    organizationId: "org-1",
    type: "http_api_key",
    name: "API",
    description: null,
    status: "ACTIVE",
    configJson: { authScheme: "API_KEY", authLocation: "HEADER", authName: "Authorization" },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    rotatedAt: null,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestStatusCode: null,
    lastTestDurationMs: null,
    lastTestMessage: null
  };
}
