"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { apiClient, ApiError } from "../../lib/api-client";
import { useAuth } from "../../features/auth/use-auth";
import Link from "next/link";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { register, handleSubmit } = useForm<FormValues>({ resolver: zodResolver(schema) });
  const { login } = useAuth();
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(values: FormValues) {
    setError(undefined);
    try {
      const result = await apiClient.post("/auth/login", values);
      await login(result);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-art" aria-label="FlowMind visual identity"><img src="/brand/koi-hero.webp" alt="" /><div className="auth-art-copy"><span className="eyebrow">FlowMind</span><h1>Keep every workflow moving.</h1><p>Build, observe and recover complex automation with confidence.</p></div></section>
      <section className="auth-panel"><div className="auth-card"><header><span className="eyebrow">Welcome back</span><h1>Sign in to FlowMind</h1><p className="muted">Continue to your workspace and active workflows.</p></header>
      <form onSubmit={handleSubmit(onSubmit)}>
        <label>Email address<input autoComplete="email" inputMode="email" placeholder="you@company.com" {...register("email")} /></label>
        <label>Password<input autoComplete="current-password" placeholder="At least 8 characters" type="password" {...register("password")} /></label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="submit">Sign in</button>
      </form><p className="auth-foot">New to FlowMind? <Link href="/register">Create an account</Link></p></div></section>
    </main>
  );
}
