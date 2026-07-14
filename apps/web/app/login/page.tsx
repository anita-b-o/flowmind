"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { apiClient, ApiError } from "../../lib/api-client";
import { useAuth } from "../../features/auth/use-auth";

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
    <main className="content">
      <form className="panel stack" onSubmit={handleSubmit(onSubmit)}>
        <h1>Login</h1>
        <input placeholder="Email" {...register("email")} />
        <input placeholder="Password" type="password" {...register("password")} />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Login</button>
      </form>
    </main>
  );
}
