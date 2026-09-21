"use client";

import { useAuth } from "../../features/auth/use-auth";

export default function MembersPage() {
  const { user, organizations, activeOrganizationId } = useAuth();
  const organization = organizations.find((item) => item.id === activeOrganizationId);
  return <main className="content stack">
    <header className="page-header"><div><h1>Organization Members</h1><p className="muted">Your membership in the current workspace.</p></div></header>
    <section className="panel stack"><h2>{organization?.name ?? "Workspace"}</h2><dl className="settings-details"><div><dt>Member</dt><dd>{user?.name ?? user?.email ?? "—"}</dd></div><div><dt>Email</dt><dd>{user?.email ?? "—"}</dd></div><div><dt>Role</dt><dd>{organization?.role ?? "—"}</dd></div></dl></section>
  </main>;
}
