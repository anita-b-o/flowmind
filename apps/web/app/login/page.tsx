"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiClient } from "../../lib/api-client";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { register, handleSubmit } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    const result = await apiClient.post("/auth/login", values);
    localStorage.setItem("accessToken", result.accessToken);
    if (result.defaultOrganizationId) {
      localStorage.setItem("organizationId", result.defaultOrganizationId);
    }
    window.location.href = "/dashboard";
  }

  return (
    <main className="content">
      <form className="panel stack" onSubmit={handleSubmit(onSubmit)}>
        <h1>Login</h1>
        <input placeholder="Email" {...register("email")} />
        <input placeholder="Password" type="password" {...register("password")} />
        <button type="submit">Login</button>
      </form>
    </main>
  );
}
