"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import type { ConnectionSummary, CreateConnectionDto, HttpAuthScheme } from "./types";

const httpSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  authScheme: z.enum(["API_KEY", "BEARER", "BASIC", "CUSTOM_HEADERS"]),
  baseUrl: z.string().optional(),
  authLocation: z.enum(["HEADER", "QUERY"]).optional(),
  authName: z.string().optional(),
  username: z.string().optional(),
  secretValue: z.string().optional(),
  secretHeaders: z.string().default("{}"),
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

export function HttpConnectionForm({ onSubmit, onCancel, pending }: { onSubmit: (dto: CreateConnectionDto) => Promise<void>; onCancel: () => void; pending?: boolean }) {
  const form = useForm<z.infer<typeof httpSchema>>({
    resolver: zodResolver(httpSchema),
    defaultValues: {
      name: "",
      description: "",
      authScheme: "API_KEY",
      baseUrl: "",
      authLocation: "HEADER",
      authName: "Authorization",
      username: "",
      secretValue: "",
      secretHeaders: "{}",
      additionalHeaders: "{}"
    }
  });
  const scheme = useWatch({ control: form.control, name: "authScheme" });
  useEffect(() => () => form.reset(), [form]);
  return (
    <form
      className="stack"
      onSubmit={form.handleSubmit(async (values) => {
        await onSubmit({
          type: "HTTP",
          name: values.name,
          description: values.description,
          authScheme: values.authScheme,
          baseUrl: values.baseUrl || undefined,
          authLocation: values.authScheme === "API_KEY" ? values.authLocation : undefined,
          authName: values.authScheme === "API_KEY" ? values.authName : undefined,
          username: values.authScheme === "BASIC" ? values.username : undefined,
          secretValue: values.authScheme === "CUSTOM_HEADERS" ? undefined : values.secretValue,
          secretHeaders: values.authScheme === "CUSTOM_HEADERS" ? parseHeaders(values.secretHeaders) : undefined,
          additionalHeaders: parseHeaders(values.additionalHeaders)
        });
        form.reset();
      })}
    >
      <div className="workflow-form-grid">
        <label>Name<input {...form.register("name")} /></label>
        <label>Auth scheme<select {...form.register("authScheme")}>{authSchemes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
      </div>
      <label>Description<input {...form.register("description")} /></label>
      <label>Base URL<input placeholder="https://api.example.com" {...form.register("baseUrl")} /></label>
      {scheme === "API_KEY" && (
        <div className="workflow-form-grid">
          <label>Auth location<select {...form.register("authLocation")}><option value="HEADER">Header</option><option value="QUERY">Query</option></select></label>
          <label>Auth name<input placeholder="Authorization or api_key" {...form.register("authName")} /></label>
        </div>
      )}
      {scheme === "BASIC" && <label>Username<input {...form.register("username")} /></label>}
      {scheme !== "CUSTOM_HEADERS" && <label>{scheme === "BASIC" ? "Password" : "Secret"}<input type="password" autoComplete="new-password" {...form.register("secretValue")} /></label>}
      {scheme === "CUSTOM_HEADERS" && <label>Secret headers<textarea rows={4} placeholder='{"Authorization":"Bearer token"}' {...form.register("secretHeaders")} /></label>}
      <label>Public headers<textarea rows={4} {...form.register("additionalHeaders")} /></label>
      <DialogActions pending={pending} onCancel={() => { form.reset(); onCancel(); }} />
    </form>
  );
}

export const HttpApiKeyConnectionForm = HttpConnectionForm;

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

export function RotateConnectionSecretDialog({
  connection,
  onRotate,
  onClose,
  pending
}: {
  connection: ConnectionSummary | null;
  onRotate: (payload: { secretValue?: string; secretHeaders?: Record<string, string> }) => Promise<void>;
  onClose: () => void;
  pending?: boolean;
}) {
  const form = useForm<{ secretValue: string; secretHeaders: string }>({ defaultValues: { secretValue: "", secretHeaders: "{}" } });
  useEffect(() => {
    if (!connection) form.reset();
  }, [connection, form]);
  if (!connection) return null;
  const customHeaders = connection.authScheme === "CUSTOM_HEADERS";
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Rotate connection secret">
        <h2>Rotate secret</h2>
        <p className="muted">{connection.name}</p>
        <form
          className="stack"
          onSubmit={form.handleSubmit(async (values) => {
            await onRotate(customHeaders ? { secretHeaders: parseHeaders(values.secretHeaders) } : { secretValue: values.secretValue });
            form.reset();
          })}
        >
          {customHeaders ? (
            <label>New secret headers<textarea rows={4} {...form.register("secretHeaders", { required: true })} /></label>
          ) : (
            <label>New secret<input type="password" autoComplete="new-password" {...form.register("secretValue", { required: true })} /></label>
          )}
          <DialogActions pending={pending} onCancel={() => { form.reset(); onClose(); }} confirmLabel="Rotate" />
        </form>
      </section>
    </div>
  );
}

export function TestConnectionDialog({ connection, result, onTest, onClose, pending }: { connection: ConnectionSummary | null; result?: { success: boolean; durationMs: number; status?: number; message?: string }; onTest: (url?: string) => Promise<void>; onClose: () => void; pending?: boolean }) {
  const form = useForm<{ url: string }>({ defaultValues: { url: "" } });
  if (!connection) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Test connection">
        <h2>Test connection</h2>
        <form className="stack" onSubmit={form.handleSubmit((values) => onTest(values.url || undefined))}>
          {connection.type !== "SMTP" && <label>Test URL or path<input placeholder="/health" {...form.register("url")} /></label>}
          {result && <p>{result.success ? "Success" : "Failed"} in {result.durationMs} ms{result.status ? `, status ${result.status}` : ""}{result.message ? `: ${result.message}` : ""}</p>}
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
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
}

const authSchemes: Array<{ value: HttpAuthScheme; label: string }> = [
  { value: "API_KEY", label: "API key" },
  { value: "BEARER", label: "Bearer token" },
  { value: "BASIC", label: "Basic auth" },
  { value: "CUSTOM_HEADERS", label: "Custom headers" }
];
