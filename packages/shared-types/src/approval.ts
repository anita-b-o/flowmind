import type { OrganizationRole } from "./index";

export const APPROVAL_LIMITS = {
  title: 160,
  description: 2_000,
  summary: 4_000,
  decisionComment: 1_000,
  maxExpirationSeconds: 365 * 24 * 60 * 60
} as const;

export const APPROVAL_ALLOWED_ROLES = ["editor", "admin", "owner"] as const;
export type ApprovalAllowedRole = (typeof APPROVAL_ALLOWED_ROLES)[number];
export type ApprovalStatusValue = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export type ApprovalConfig = {
  title: string;
  description?: string;
  summary?: string;
  expirationSeconds?: number;
  assigneePolicy: "ANY_AUTHORIZED_USER";
  allowedRoles: ApprovalAllowedRole[];
};

export function normalizeApprovalConfig(value: Record<string, unknown>): ApprovalConfig {
  const title = text(value.title, APPROVAL_LIMITS.title);
  if (!title) throw new Error("APPROVAL title is required");
  const expirationSeconds = value.expirationSeconds === undefined || value.expirationSeconds === null || value.expirationSeconds === ""
    ? undefined : Number(value.expirationSeconds);
  if (expirationSeconds !== undefined && (!Number.isInteger(expirationSeconds) || expirationSeconds < 1 || expirationSeconds > APPROVAL_LIMITS.maxExpirationSeconds)) {
    throw new Error("APPROVAL expiration is invalid");
  }
  const roles = Array.isArray(value.allowedRoles) ? value.allowedRoles.map(String) : ["editor", "admin", "owner"];
  if (!roles.length || roles.some((role) => !APPROVAL_ALLOWED_ROLES.includes(role as ApprovalAllowedRole))) throw new Error("APPROVAL allowed roles are invalid");
  return {
    title,
    ...(text(value.description, APPROVAL_LIMITS.description) ? { description: text(value.description, APPROVAL_LIMITS.description) } : {}),
    ...(text(value.summary, APPROVAL_LIMITS.summary) ? { summary: text(value.summary, APPROVAL_LIMITS.summary) } : {}),
    ...(expirationSeconds ? { expirationSeconds } : {}),
    assigneePolicy: "ANY_AUTHORIZED_USER",
    allowedRoles: [...new Set(roles)] as ApprovalAllowedRole[]
  };
}

export function canDecideApproval(role: OrganizationRole | string, allowedRoles: readonly string[]) {
  return role === "owner" || role === "admin" || (role === "editor" && allowedRoles.includes("editor"));
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").trim().slice(0, max);
}
