import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const createdOrganizationIds: string[] = [];

describe("workflow template cleanup", () => {
  afterAll(async () => {
    const templates = await prisma.workflowTemplate.findMany({
      where: { organizationId: { in: createdOrganizationIds } },
      select: { id: true }
    });
    await prisma.workflowTemplateVersion.deleteMany({ where: { templateId: { in: templates.map(({ id }) => id) } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    await prisma.$disconnect();
  });

  it("removes template-version dependents before owned workflow versions without touching another organization", async () => {
    const owned = await createTemplateSource("owned");
    const foreign = await createTemplateSource("foreign");

    await prisma.workflowTemplateVersion.deleteMany({ where: { id: owned.templateVersionId } });
    await prisma.workflowVersion.delete({ where: { id: owned.workflowVersionId } });

    expect(await prisma.workflowVersion.findUnique({ where: { id: foreign.workflowVersionId } })).not.toBeNull();
    expect(await prisma.workflowTemplateVersion.findUnique({ where: { id: foreign.templateVersionId } })).not.toBeNull();
  });
});

async function createTemplateSource(prefix: string) {
  const unique = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const organization = await prisma.organization.create({ data: { name: unique, slug: unique } });
  createdOrganizationIds.push(organization.id);
  const user = await prisma.user.create({ data: { email: `${unique}@example.com`, name: unique, passwordHash: "hash" } });
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role: "owner" } });
  const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, createdByUserId: user.id, name: unique } });
  const workflowVersion = await prisma.workflowVersion.create({
    data: { organizationId: organization.id, workflowId: workflow.id, createdByUserId: user.id, versionNumber: 1, definitionJson: {} }
  });
  const template = await prisma.workflowTemplate.create({ data: { organizationId: organization.id, createdByUserId: user.id, name: unique } });
  const templateVersion = await prisma.workflowTemplateVersion.create({
    data: { templateId: template.id, versionNumber: 1, definitionJson: {}, dependencyManifestJson: {}, sourceWorkflowId: workflow.id, sourceWorkflowVersionId: workflowVersion.id }
  });
  return { workflowVersionId: workflowVersion.id, templateVersionId: templateVersion.id };
}
