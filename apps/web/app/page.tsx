import Link from "next/link";
import { BrandHero } from "../components/brand";

export default function HomePage() {
  return (
    <main className="brand-page content">
      <BrandHero eyebrow="Workflow orchestration, in motion" title="Complex automation. Clear thinking.">
        <p>Design reliable workflows, understand every execution and recover safely when real systems get complicated.</p>
        <div className="brand-actions"><Link href="/register">Start building</Link><Link className="secondary" href="/login">Sign in</Link></div>
      </BrandHero>
    </main>
  );
}
