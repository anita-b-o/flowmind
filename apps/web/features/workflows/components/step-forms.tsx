"use client";

import Link from "next/link";
import type { FieldErrors, UseFormRegister } from "react-hook-form";
import { useConnections } from "../../connections/hooks";
import type { WorkflowEditorFormValue } from "../workflow-builder";

type StepFormProps = {
  index: number;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  disabled: boolean;
};

export function StepForm({ index, type, register, errors, disabled }: StepFormProps & { type: string }) {
  if (type === "http_request") {
    return <HttpStepForm index={index} register={register} errors={errors} disabled={disabled} />;
  }
  if (type.startsWith("ai_")) {
    return <AiStepForm index={index} type={type} register={register} errors={errors} disabled={disabled} />;
  }
  if (type === "email_notification") {
    return <EmailStepForm index={index} register={register} errors={errors} disabled={disabled} />;
  }
  if (type === "database_record") {
    return <DatabaseStepForm index={index} register={register} errors={errors} disabled={disabled} />;
  }
  return <ConditionalStepForm index={index} register={register} errors={errors} disabled={disabled} />;
}

export function HttpStepForm({ index, register, errors, disabled }: StepFormProps) {
  const connections = useConnections({ type: "HTTP_API_KEY", status: "ACTIVE" });
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Connection
          <select disabled={disabled || connections.isLoading} {...register(`steps.${index}.config.connectionId`)}>
            <option value="">Select a connection</option>
            {connections.data?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} ({connection.credential})
              </option>
            ))}
          </select>
          <FieldError message={configError(errors, index, "connectionId")} />
        </label>
        <label>
          Method
          <select disabled={disabled} {...register(`steps.${index}.config.method`)}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <FieldError message={configError(errors, index, "method")} />
        </label>
        <label>
          URL
          <input disabled={disabled} placeholder="https://api.example.com/items" {...register(`steps.${index}.config.url`)} />
          <FieldError message={configError(errors, index, "url")} />
        </label>
      </div>
      <p className="muted">
        <Link href="/connections">Create a HTTP API key connection</Link>
      </p>
      <label>
        Headers
        <textarea rows={4} disabled={disabled} {...register(`steps.${index}.config.headers`)} />
        <FieldError message={configError(errors, index, "headers")} />
      </label>
      <label>
        Body
        <textarea rows={5} disabled={disabled} placeholder='{"status":"new"}' {...register(`steps.${index}.config.body`)} />
        <FieldError message={configError(errors, index, "body")} />
      </label>
    </div>
  );
}

export function AiStepForm({ index, type, register, errors, disabled }: StepFormProps & { type: string }) {
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Provider
          <input disabled={disabled} {...register(`steps.${index}.config.provider`)} />
        </label>
        {type === "ai_summary" && (
          <label>
            Max words
            <input type="number" min={5} max={500} disabled={disabled} {...register(`steps.${index}.config.max_words`, { valueAsNumber: true })} />
          </label>
        )}
      </div>
      <label>
        Prompt
        <textarea rows={5} disabled={disabled} {...register(`steps.${index}.config.text`)} />
        <FieldError message={configError(errors, index, "text")} />
      </label>
      {type === "ai_classification" && (
        <label>
          Labels
          <input disabled={disabled} placeholder="high, normal, low" {...register(`steps.${index}.config.labels`)} />
        </label>
      )}
      {type === "ai_structured_extraction" && (
        <label>
          Schema
          <textarea rows={5} disabled={disabled} {...register(`steps.${index}.config.schema`)} />
          <FieldError message={configError(errors, index, "schema")} />
        </label>
      )}
    </div>
  );
}

export function EmailStepForm({ index, register, errors, disabled }: StepFormProps) {
  const connections = useConnections({ type: "SMTP", status: "ACTIVE" });
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Connection
          <select disabled={disabled || connections.isLoading} {...register(`steps.${index}.config.connectionId`)}>
            <option value="">Select a connection</option>
            {connections.data?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} ({connection.credential})
              </option>
            ))}
          </select>
          <FieldError message={configError(errors, index, "connectionId")} />
        </label>
        <label>
          Recipient
          <input disabled={disabled} placeholder="sales@example.com" {...register(`steps.${index}.config.to`)} />
          <FieldError message={configError(errors, index, "to")} />
        </label>
        <label>
          Subject
          <input disabled={disabled} {...register(`steps.${index}.config.subject`)} />
          <FieldError message={configError(errors, index, "subject")} />
        </label>
      </div>
      <p className="muted">
        <Link href="/connections">Create a SMTP connection</Link>
      </p>
      <label>
        Body
        <textarea rows={5} disabled={disabled} {...register(`steps.${index}.config.text`)} />
        <FieldError message={configError(errors, index, "text")} />
      </label>
    </div>
  );
}

export function DatabaseStepForm({ index, register, errors, disabled }: StepFormProps) {
  return (
    <div className="stack">
      <label>
        Collection
        <input disabled={disabled} placeholder="leads" {...register(`steps.${index}.config.collection`)} />
        <FieldError message={configError(errors, index, "collection")} />
      </label>
      <label>
        Data
        <textarea rows={6} disabled={disabled} {...register(`steps.${index}.config.data`)} />
        <FieldError message={configError(errors, index, "data")} />
      </label>
    </div>
  );
}

export function ConditionalStepForm({ index, register, errors, disabled }: StepFormProps) {
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Expression
          <input disabled={disabled} placeholder="{{trigger.body.priority}}" {...register(`steps.${index}.config.left`)} />
          <FieldError message={configError(errors, index, "left")} />
        </label>
        <label>
          Operator
          <select disabled={disabled} {...register(`steps.${index}.config.operator`)}>
            <option value="equals">Equals</option>
            <option value="not_equals">Not equals</option>
            <option value="contains">Contains</option>
          </select>
          <FieldError message={configError(errors, index, "operator")} />
        </label>
        <label>
          Compare with
          <input disabled={disabled} {...register(`steps.${index}.config.right`)} />
        </label>
      </div>
      <label className="workflow-checkbox">
        <input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.skipNextOnFalse`)} />
        Skip next step when false
      </label>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? <span className="field-error">{message}</span> : null;
}

function configError(errors: FieldErrors<WorkflowEditorFormValue>, index: number, key: string) {
  const config = errors.steps?.[index]?.config as Record<string, { message?: string }> | undefined;
  return config?.[key]?.message;
}
