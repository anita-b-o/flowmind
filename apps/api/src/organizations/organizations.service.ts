import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string) {
    return this.prisma.organization.findMany({
      where: {
        members: {
          some: { userId, status: "ACTIVE" }
        }
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async createOwnedOrganization(userId: string, name: string) {
    const slug = await this.uniqueSlug(name);
    return this.prisma.organization.create({
      data: {
        name,
        slug,
        members: {
          create: {
            userId,
            role: "owner"
          }
        }
      }
    });
  }

  private async uniqueSlug(name: string) {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    let slug = base || "organization";
    let suffix = 1;

    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }

    return slug;
  }
}
