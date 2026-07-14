import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OrganizationRole } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { REQUIRED_ROLES_KEY } from "./roles.decorator";

const roleRank: Record<OrganizationRole, number> = {
  [OrganizationRole.Owner]: 4,
  [OrganizationRole.Admin]: 3,
  [OrganizationRole.Editor]: 2,
  [OrganizationRole.Viewer]: 1
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OrganizationRole[]>(REQUIRED_ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: { userId: string };
      organization?: { organizationId: string };
    }>();
    const userId = request.user?.userId;
    const organizationId = request.organization?.organizationId;
    if (!userId || !organizationId) {
      throw new ForbiddenException("Missing organization context");
    }

    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, status: "ACTIVE" }
    });
    const userRank = membership ? roleRank[membership.role as OrganizationRole] : 0;
    const requiredRank = Math.min(...required.map((role) => roleRank[role]));

    if (userRank < requiredRank) {
      throw new ForbiddenException("Insufficient role");
    }
    return true;
  }
}
