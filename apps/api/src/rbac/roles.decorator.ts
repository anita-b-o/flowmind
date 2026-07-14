import { SetMetadata } from "@nestjs/common";
import { OrganizationRole } from "@automation/shared-types";

export const REQUIRED_ROLES_KEY = "required_roles";
export const Roles = (...roles: OrganizationRole[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);
