"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { apiClient, ApiError } from "../../lib/api-client";
import { useAuth } from "../../features/auth/use-auth";
import Link from "next/link";

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  organizationName: z.string().min(2)
});

type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const { register, handleSubmit } = useForm<FormValues>({ resolver: zodResolver(schema) });
  const { login } = useAuth();
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(values: FormValues) {
    setError(undefined);
    try {
      const result = await apiClient.post("/auth/register", values);
      await login(result);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-art" aria-label="FlowMind visual identity"><img src="/brand/koi-hero.webp" alt="" /><div className="auth-art-copy"><span className="eyebrow">Start in flow</span><h1>Build systems that stay understandable.</h1><p>From the first node to production recovery, FlowMind keeps the whole story connected.</p></div></section>
      <section className="auth-panel"><div className="auth-card"><header><span className="eyebrow">Create your workspace</span><h1>Get started</h1><p className="muted">Set up your organization and begin with a draft workflow.</p></header>
      <form onSubmit={handleSubmit(onSubmit)}>
        <label>Your name<input autoComplete="name" placeholder="Ada Lovelace" {...register("name")} /></label>
        <label>Work email<input autoComplete="email" inputMode="email" placeholder="you@company.com" {...register("email")} /></label>
        <label>Password<input autoComplete="new-password" placeholder="At least 8 characters" type="password" {...register("password")} /></label>
        <label>Organization<input autoComplete="organization" placeholder="Company or team name" {...register("organizationName")} /></label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="submit">Create account</button>
      </form><p className="auth-foot">Already have an account? <Link href="/login">Sign in</Link></p></div></section>
    </main>
  );
}
