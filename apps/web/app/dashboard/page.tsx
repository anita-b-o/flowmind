"use client";

import Link from "next/link";
import { useAuth } from "../../features/auth/use-auth";
import { BrandHero } from "../../components/brand";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <main className="content stack">
        <BrandHero eyebrow="Workspace overview" title={`Welcome${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.`}><p>See what is moving, what needs attention and where to build next.</p><div className="brand-actions"><Link href="/workflows">Open workflows</Link><Link className="secondary" href="/templates">Explore templates</Link></div></BrandHero>
        <div className="grid">
          <div className="panel stat-card">
            <strong>Workflow executions</strong>
            <p className="stat-value">—</p><p className="muted">Live activity will appear here.</p>
          </div>
          <div className="panel stat-card">
            <strong>Queue health</strong>
            <p className="stat-value">Ready</p><p className="muted">Connect the API to see live metrics.</p>
          </div>
          <div className="panel stat-card">
            <strong>LLM cost</strong>
            <p className="stat-value">—</p><p className="muted">Tracking starts when AI steps run.</p>
          </div>
        </div>
    </main>
  );
}
