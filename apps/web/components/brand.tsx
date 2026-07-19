import type { ReactNode } from "react";

export function BrandHero({ eyebrow, title, children }: { eyebrow?: string; title: string; children: ReactNode }) {
  return <section className="brand-hero"><div className="brand-hero-copy">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><div className="brand-hero-body">{children}</div></div><div className="brand-hero-art" aria-hidden="true"><img src="/brand/koi-hero.webp" alt="" /></div></section>;
}

export function EmptyState({ title, children, action, branded = false }: { title: string; children: ReactNode; action?: ReactNode; branded?: boolean }) {
  return <div className={`empty-state ${branded ? "empty-state--branded" : ""}`}>{branded && <img src="/brand/koi-line.webp" alt="" aria-hidden="true" />}<h3>{title}</h3><div className="muted">{children}</div>{action && <div className="empty-state-action">{action}</div>}</div>;
}
