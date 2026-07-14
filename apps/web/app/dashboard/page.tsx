import Link from "next/link";

const nav = [
  ["Workflows", "/workflows"],
  ["Executions", "/executions"],
  ["Connections", "/connections"],
  ["Members", "/members"],
  ["Audit Log", "/audit-log"],
  ["Settings", "/settings"]
];

export default function DashboardPage() {
  return (
    <main className="shell">
      <aside className="sidebar stack">
        <strong>Flowmind</strong>
        {nav.map(([label, href]) => (
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
