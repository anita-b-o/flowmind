"use client";

import { useAuth } from "../../features/auth/use-auth";

export default function SettingsPage() {
  const { user, organizations, activeOrganizationId } = useAuth();
  const organization = organizations.find((item) => item.id === activeOrganizationId);
  return (
    <main className="content stack">
      <header className="page-header"><div><h1>Settings</h1><p className="muted">Your current workspace and account details.</p></div></header>
      <section className="panel stack">
        <h2>Workspace</h2>
        <dl className="settings-details"><div><dt>Name</dt><dd>{organization?.name ?? "—"}</dd></div><div><dt>Slug</dt><dd>{organization?.slug ?? "—"}</dd></div><div><dt>Your role</dt><dd>{organization?.role ?? "—"}</dd></div></dl>
      </section>
      <section className="panel stack">
        <h2>Account</h2>
        <dl className="settings-details"><div><dt>Name</dt><dd>{user?.name ?? "—"}</dd></div><div><dt>Email</dt><dd>{user?.email ?? "—"}</dd></div></dl>
      </section>
      <section className="panel stack">
        <h2>Access and security</h2>
        <p className="muted">Your access to this workspace is determined by your organization role. Switch workspaces from the navigation to view another membership.</p>
        <dl className="settings-details"><div><dt>Current access</dt><dd>{organization?.role ?? "—"}</dd></div><div><dt>Signed in as</dt><dd>{user?.email ?? "—"}</dd></div></dl>
      </section>
    </main>
  );
}
