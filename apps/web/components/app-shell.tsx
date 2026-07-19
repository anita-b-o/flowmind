"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { canManageDataStores, canViewAuditLog, canViewDeadLetters } from "../features/auth/rbac";
import { RequireAuth } from "../features/auth/require-auth";
import { useAuth } from "../features/auth/use-auth";

const PUBLIC_ROUTES = new Set(["/", "/login", "/register"]);

type NavItem = { label: string; href: string; short: string };
type NavGroup = { label: string; items: NavItem[] };

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_ROUTES.has(pathname)) return <>{children}</>;
  return <RequireAuth><AppShell>{children}</AppShell></RequireAuth>;
}

function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const auth = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const activeOrganization = auth.organizations.find((organization) => organization.id === auth.activeOrganizationId);
  const role = activeOrganization?.role;
  const groups = useMemo<NavGroup[]>(() => [
    { label: "Home", items: [{ label: "Dashboard", href: "/dashboard", short: "HM" }] },
    { label: "Build", items: [
      { label: "Workflows", href: "/workflows", short: "WF" },
      { label: "Templates", href: "/templates", short: "TP" }
    ] },
    { label: "Operate", items: [
      { label: "Executions", href: "/executions", short: "EX" },
      { label: "Approvals", href: "/approvals", short: "AP" },
      ...(canViewDeadLetters(role) ? [{ label: "Dead letters", href: "/dead-letter-executions", short: "DL" }] : []),
      { label: "Notifications", href: "/notifications", short: "NT" }
    ] },
    { label: "Resources", items: [
      ...(canManageDataStores(role) ? [{ label: "Data Stores", href: "/data-stores", short: "DS" }] : []),
      { label: "Connections", href: "/connections", short: "CN" }
    ] },
    { label: "Organization", items: [
      { label: "Members", href: "/members", short: "MB" },
      ...(canViewAuditLog(role) ? [{ label: "Audit log", href: "/audit-log", short: "AL" }] : []),
      { label: "Settings", href: "/settings", short: "ST" }
    ] }
  ], [role]);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setMobileOpen(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <div className={`app-shell ${collapsed ? "app-shell--collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`app-sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="app-brand-row">
          <Link href="/dashboard" className="app-brand" aria-label="FlowMind home">
            <span className="koi-mark" aria-hidden="true"><img src="/brand/koi-line.webp" alt="" /></span>
            <span className="app-brand-name">FlowMind</span>
          </Link>
          <button className="icon-button sidebar-collapse" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>{collapsed ? "→" : "←"}</button>
        </div>
        <nav className="app-nav">
          {groups.map((group) => group.items.length ? (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return <Link key={item.href} href={item.href} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}><span className="nav-icon" aria-hidden="true">{item.short}</span><span className="nav-label">{item.label}</span></Link>;
              })}
            </div>
          ) : null)}
        </nav>
        <div className="sidebar-account">
          <label className="organization-switcher">
            <span>Workspace</span>
            <select aria-label="Active organization" value={auth.activeOrganizationId ?? ""} onChange={(event) => auth.setActiveOrganizationId(event.target.value)}>
              {auth.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
          </label>
          <div className="account-row">
            <span className="account-avatar" aria-hidden="true">{(auth.user?.name ?? auth.user?.email ?? "U").slice(0, 1).toUpperCase()}</span>
            <span className="account-copy"><strong>{auth.user?.name ?? auth.user?.email ?? "Account"}</strong><small>{role ?? "member"}</small></span>
            <button type="button" className="link-button" onClick={() => void auth.logout()}>Log out</button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="mobile-topbar">
          <button type="button" className="icon-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button>
          <Link href="/dashboard" className="app-brand"><span className="koi-mark" aria-hidden="true"><img src="/brand/koi-line.webp" alt="" /></span><span className="app-brand-name">FlowMind</span></Link>
        </header>
        <div id="main-content" className="app-content">{children}</div>
      </div>
    </div>
  );
}
