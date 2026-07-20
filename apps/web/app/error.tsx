"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep client reporting free of request payloads and credentials.
    console.error("FlowMind page error", { name: error.name, digest: error.digest });
  }, [error]);
  return <main className="content stack">
    <section className="panel stack" role="alert">
      <h1>Something went wrong</h1>
      <p>FlowMind could not load this page. Your saved workflows and execution history were not changed.</p>
      <div><button type="button" onClick={reset}>Try again</button></div>
    </section>
  </main>;
}
