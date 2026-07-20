import Link from "next/link";

export default function NotFound() {
  return <main className="content stack">
    <section className="panel empty-state--branded stack">
      <span className="eyebrow">404</span>
      <h1>Page not found</h1>
      <p>The FlowMind page you requested does not exist or is no longer available.</p>
      <div><Link href="/">Return to FlowMind</Link></div>
    </section>
  </main>;
}
