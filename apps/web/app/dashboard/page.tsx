"use client";

import Link from "next/link";
import { canViewAuditLog, canViewDeadLetters } from "../../features/auth/rbac";
import { useAuth } from "../../features/auth/use-auth";

const nav = [
  ["Workflows", "/workflows"],
  ["Executions", "/executions"],
  ["Connections", "/connections"],
  ["Members", "/members"],
  ["Settings", "/settings"]
];

export default function DashboardPage() {
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;
  const visibleNav = [
    ...nav,
    ...(canViewDeadLetters(role) ? [["Dead letters", "/dead-letter-executions"]] : []),
    ...(canViewAuditLog(role) ? [["Audit log", "/audit-log"]] : [])
  ];

  return (
    <main className="shell">
      <aside className="sidebar stack">
        <strong>Flowmind</strong>
        {visibleNav.map(([label, href]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </aside>
      <section className="content stack">
        <h1>Dashboard</h1>
        <div className="grid">
          <div className="panel">
            <strong>Workflow executions</strong>
            <p className="muted">No executions yet.</p>
          </div>
          <div className="panel">
            <strong>Queue health</strong>
            <p className="muted">Connect the API to see live metrics.</p>
          </div>
          <div className="panel">
            <strong>LLM cost</strong>
            <p className="muted">Cost tracking starts when AI steps run.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
