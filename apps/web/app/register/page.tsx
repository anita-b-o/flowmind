"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiClient } from "../../lib/api-client";

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  organizationName: z.string().min(2)
});

type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const { register, handleSubmit } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    const result = await apiClient.post("/auth/register", values);
    localStorage.setItem("accessToken", result.accessToken);
    localStorage.setItem("organizationId", result.defaultOrganizationId);
    window.location.href = "/dashboard";
  }

  return (
    <main className="content">
      <form className="panel stack" onSubmit={handleSubmit(onSubmit)}>
        <h1>Register</h1>
        <input placeholder="Name" {...register("name")} />
        <input placeholder="Email" {...register("email")} />
        <input placeholder="Password" type="password" {...register("password")} />
        <input placeholder="Organization" {...register("organizationName")} />
        <button type="submit">Create account</button>
      </form>
    </main>
  );
}
