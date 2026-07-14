import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: { userId: string };
      organization?: { organizationId: string };
    }>();
    const organizationId = request.headers["x-organization-id"];
    const userId = request.user?.userId;

    if (!organizationId || !userId) {
      throw new ForbiddenException("Organization context required");
    }

    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: "ACTIVE" }
    });
    if (!membership) {
      throw new ForbiddenException("Organization access denied");
    }

    request.organization = { organizationId };
    return true;
  }
}
