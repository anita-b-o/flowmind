"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { apiClient, ApiError } from "../../lib/api-client";
import { useAuth } from "../../features/auth/use-auth";

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
    <main className="content">
      <form className="panel stack" onSubmit={handleSubmit(onSubmit)}>
        <h1>Register</h1>
        <input placeholder="Name" {...register("name")} />
        <input placeholder="Email" {...register("email")} />
        <input placeholder="Password" type="password" {...register("password")} />
        <input placeholder="Organization" {...register("organizationName")} />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Create account</button>
      </form>
    </main>
  );
}
