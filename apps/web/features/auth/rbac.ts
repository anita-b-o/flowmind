export type OrganizationRole = "owner" | "admin" | "editor" | "viewer" | string | undefined;

const rank: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export function canViewDeadLetters(role: OrganizationRole) {
  return roleRank(role) >= rank.admin;
}

export function canRetryExecution(role: OrganizationRole) {
  return roleRank(role) >= rank.editor;
}

export function canRunWorkflow(role: OrganizationRole) {
  return roleRank(role) >= rank.editor;
}
export function canRestoreWorkflowVersion(role: OrganizationRole) { return roleRank(role) >= rank.editor; }
export function canCreateTemplate(role: OrganizationRole) { return roleRank(role) >= rank.editor; }
export function canAdminTemplate(role: OrganizationRole) { return roleRank(role) >= rank.admin; }

export function canCancelExecution(role: OrganizationRole) {
  return roleRank(role) >= rank.editor;
}

export function canViewAuditLog(role: OrganizationRole) {
  return roleRank(role) >= rank.admin;
}

export function canListConnections(role: OrganizationRole) {
  return roleRank(role) >= rank.editor;
}

export function canManageConnections(role: OrganizationRole) {
  return roleRank(role) >= rank.admin;
}

export function canRunRealWorkflowTest(role: OrganizationRole) {
  return roleRank(role) >= rank.admin;
}

export function canDeleteConnections(role: OrganizationRole) {
  return roleRank(role) >= rank.owner;
}

export function canManageDataStores(role: OrganizationRole) {
  return roleRank(role) >= rank.editor;
}

export function canManageNotificationRules(role: OrganizationRole) { return roleRank(role) >= rank.editor; }
export function canRetryNotification(role: OrganizationRole) { return roleRank(role) >= rank.admin; }

function roleRank(role: OrganizationRole) {
  return role ? rank[role] ?? 0 : 0;
}
