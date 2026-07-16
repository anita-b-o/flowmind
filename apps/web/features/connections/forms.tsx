"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { ConnectionSummary, CreateConnectionDto } from "./types";

const httpSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  authLocation: z.enum(["HEADER", "QUERY"]),
  authName: z.string().min(1),
  secretValue: z.string().min(1),
  additionalHeaders: z.string().default("{}")
});

const smtpSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
  fromName: z.string().optional(),
  fromEmail: z.string().email()
});

export function HttpApiKeyConnectionForm({ onSubmit, onCancel, pending }: { onSubmit: (dto: CreateConnectionDto) => Promise<void>; onCancel: () => void; pending?: boolean }) {
  const form = useForm<z.infer<typeof httpSchema>>({
    resolver: zodResolver(httpSchema),
    defaultValues: { name: "", description: "", baseUrl: "", authLocation: "HEADER", authName: "Authorization", secretValue: "", additionalHeaders: "{}" }
  });
  useEffect(() => () => form.reset(), [form]);
  return (
    <form
      className="stack"
      onSubmit={form.handleSubmit(async (values) => {
        await onSubmit({
          type: "HTTP_API_KEY",
          name: values.name,
          description: values.description,
          baseUrl: values.baseUrl || undefined,
          authLocation: values.authLocation,
          authName: values.authName,
          secretValue: values.secretValue,
          additionalHeaders: parseHeaders(values.additionalHeaders)
        });
        form.reset();
      })}
    >
      <div className="workflow-form-grid">
        <label>Name<input {...form.register("name")} /></label>
        <label>Auth location<select {...form.register("authLocation")}><option value="HEADER">Header</option><option value="QUERY">Query</option></select></label>
      </div>
      <label>Description<input {...form.register("description")} /></label>
      <label>Base URL<input placeholder="https://api.example.com" {...form.register("baseUrl")} /></label>
      <label>Auth name<input placeholder="Authorization or api_key" {...form.register("authName")} /></label>
      <label>Secret<input type="password" autoComplete="new-password" {...form.register("secretValue")} /></label>
      <label>Additional headers<textarea rows={4} {...form.register("additionalHeaders")} /></label>
      <DialogActions pending={pending} onCancel={() => { form.reset(); onCancel(); }} />
    </form>
  );
}

export function SmtpConnectionForm({ onSubmit, onCancel, pending }: { onSubmit: (dto: CreateConnectionDto) => Promise<void>; onCancel: () => void; pending?: boolean }) {
  const form = useForm<z.infer<typeof smtpSchema>>({
    resolver: zodResolver(smtpSchema),
    defaultValues: { name: "", description: "", host: "", port: 587, secure: false, username: "", password: "", fromName: "", fromEmail: "" }
  });
  useEffect(() => () => form.reset(), [form]);
  return (
    <form
      className="stack"
      onSubmit={form.handleSubmit(async (values) => {
        await onSubmit({ type: "SMTP", ...values });
        form.reset();
      })}
    >
      <div className="workflow-form-grid">
        <label>Name<input {...form.register("name")} /></label>
        <label>Host<input {...form.register("host")} /></label>
        <label>Port<input type="number" {...form.register("port", { valueAsNumber: true })} /></label>
        <label className="workflow-checkbox"><input type="checkbox" {...form.register("secure")} /> Secure TLS</label>
      </div>
      <label>Description<input {...form.register("description")} /></label>
      <label>Username<input {...form.register("username")} /></label>
      <label>Password<input type="password" autoComplete="new-password" {...form.register("password")} /></label>
      <div className="workflow-form-grid">
        <label>From name<input {...form.register("fromName")} /></label>
        <label>From email<input {...form.register("fromEmail")} /></label>
      </div>
      <DialogActions pending={pending} onCancel={() => { form.reset(); onCancel(); }} />
    </form>
  );
}

export function RotateConnectionSecretDialog({ connection, onRotate, onClose, pending }: { connection: ConnectionSummary | null; onRotate: (secretValue: string) => Promise<void>; onClose: () => void; pending?: boolean }) {
  const form = useForm<{ secretValue: string }>({ defaultValues: { secretValue: "" } });
  useEffect(() => {
    if (!connection) form.reset();
  }, [connection, form]);
  if (!connection) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Rotate connection secret">
        <h2>Rotate secret</h2>
        <p className="muted">{connection.name}</p>
        <form className="stack" onSubmit={form.handleSubmit(async (values) => { await onRotate(values.secretValue); form.reset(); })}>
          <label>New secret<input type="password" autoComplete="new-password" {...form.register("secretValue", { required: true })} /></label>
          <DialogActions pending={pending} onCancel={() => { form.reset(); onClose(); }} confirmLabel="Rotate" />
        </form>
      </section>
    </div>
  );
}

export function TestConnectionDialog({ connection, result, onTest, onClose, pending }: { connection: ConnectionSummary | null; result?: { success: boolean; durationMs: number; status?: number }; onTest: (url?: string) => Promise<void>; onClose: () => void; pending?: boolean }) {
  const form = useForm<{ url: string }>({ defaultValues: { url: "" } });
  if (!connection) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Test connection">
        <h2>Test connection</h2>
        <form className="stack" onSubmit={form.handleSubmit((values) => onTest(values.url || undefined))}>
          {connection.type === "HTTP_API_KEY" && <label>Test URL or path<input placeholder="/health" {...form.register("url")} /></label>}
          {result && <p>{result.success ? "Success" : "Failed"} in {result.durationMs} ms{result.status ? `, status ${result.status}` : ""}</p>}
          <DialogActions pending={pending} onCancel={() => { form.reset(); onClose(); }} confirmLabel="Test" />
        </form>
      </section>
    </div>
  );
}

function DialogActions({ pending, onCancel, confirmLabel = "Save" }: { pending?: boolean; onCancel: () => void; confirmLabel?: string }) {
  return (
    <div className="workflow-actions" style={{ justifyContent: "flex-end" }}>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" disabled={pending}>{pending ? "Working..." : confirmLabel}</button>
    </div>
  );
}

function parseHeaders(value: string) {
  const parsed = JSON.parse(value || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
