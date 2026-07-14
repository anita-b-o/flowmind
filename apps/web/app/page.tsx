import Link from "next/link";

export default function HomePage() {
  return (
    <main className="content">
      <section className="panel stack">
        <div>
          <h1>Automation Platform</h1>
          <p className="muted">Build linear AI workflows with webhooks, decisions, actions and execution history.</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Link href="/login">Login</Link>
          <Link href="/register">Register</Link>
          <Link href="/dashboard">Dashboard</Link>
        </div>
      </section>
    </main>
  );
}
