import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface OrganizationContext {
  organizationId: string;
}

export const OrganizationContext = createParamDecorator((_: unknown, ctx: ExecutionContext): OrganizationContext => {
  const request = ctx.switchToHttp().getRequest<{ organization: OrganizationContext }>();
  return request.organization;
});
