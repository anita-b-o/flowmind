import { PrismaClient } from "@prisma/client";

const organizationId = required("RBAC_ORGANIZATION_ID");
const fixtures = [
  ["RBAC_ADMIN_EMAIL", "admin"],
  ["RBAC_EDITOR_EMAIL", "editor"],
  ["RBAC_VIEWER_EMAIL", "viewer"]
];
const prisma = new PrismaClient();
try {
  for (const [variable, role] of fixtures) {
    const email = required(variable).trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`${variable} must identify a pre-registered staging user`);
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      create: { organizationId, userId: user.id, role, status: "ACTIVE" },
      update: { role, status: "ACTIVE" }
    });
  }
} finally {
  await prisma.$disconnect();
}
process.stdout.write("Staging RBAC fixtures prepared\n");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
