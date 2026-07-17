"use client";

import Link from "next/link";
import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { useConnections } from "../../connections/hooks";
import type { WorkflowEditorFormValue } from "../workflow-builder";
import { catalogForSteps } from "../expressions";
import { ExpressionPreview } from "./expression-preview";
import { VariablePicker } from "./variable-picker";
import { DelayStepForm, IfStepForm, SwitchStepForm, WaitUntilStepForm } from "./control-step-forms";

type StepFormProps = {
  index: number;
  register: UseFormRegister<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  disabled: boolean;
};

export function StepForm({ index, type, register, errors, disabled, setValue, getValues }: StepFormProps & { type: string }) {
  if (type === "http_request") {
    return <HttpStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type.startsWith("ai_")) {
    return <AiStepForm index={index} type={type} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "email_notification") {
    return <EmailStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "database_record") {
    return <DatabaseStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "if") {
    return <IfStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "switch") {
    return <SwitchStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "delay") {
    return <DelayStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "wait_until") {
    return <WaitUntilStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  return <ConditionalStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
}

export function HttpStepForm({ index, register, errors, disabled, setValue, getValues }: StepFormProps) {
  const connections = useConnections({ type: "HTTP", status: "ACTIVE" });
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
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
          <ExpressionTools field={`steps.${index}.config.url`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <FieldError message={configError(errors, index, "url")} />
        </label>
      </div>
      <p className="muted">
        <Link href="/connections">Create a HTTP API key connection</Link>
      </p>
      <label>
        Headers
        <textarea rows={4} disabled={disabled} {...register(`steps.${index}.config.headers`)} />
        <ExpressionTools field={`steps.${index}.config.headers`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "headers")} />
      </label>
      <label>
        Body
        <textarea rows={5} disabled={disabled} placeholder='{"status":"new"}' {...register(`steps.${index}.config.body`)} />
        <ExpressionTools field={`steps.${index}.config.body`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "body")} />
      </label>
    </div>
  );
}

export function AiStepForm({ index, type, register, errors, disabled, setValue, getValues }: StepFormProps & { type: string }) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
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
        <ExpressionTools field={`steps.${index}.config.text`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
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
          <ExpressionTools field={`steps.${index}.config.schema`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <FieldError message={configError(errors, index, "schema")} />
        </label>
      )}
    </div>
  );
}

export function EmailStepForm({ index, register, errors, disabled, setValue, getValues }: StepFormProps) {
  const connections = useConnections({ type: "SMTP", status: "ACTIVE" });
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
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
          <ExpressionTools field={`steps.${index}.config.to`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <FieldError message={configError(errors, index, "to")} />
        </label>
        <label>
          Subject
          <input disabled={disabled} {...register(`steps.${index}.config.subject`)} />
          <ExpressionTools field={`steps.${index}.config.subject`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <FieldError message={configError(errors, index, "subject")} />
        </label>
      </div>
      <p className="muted">
        <Link href="/connections">Create a SMTP connection</Link>
      </p>
      <label>
        Body
        <textarea rows={5} disabled={disabled} {...register(`steps.${index}.config.text`)} />
        <ExpressionTools field={`steps.${index}.config.text`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "text")} />
      </label>
    </div>
  );
}

export function DatabaseStepForm({ index, register, errors, disabled, setValue, getValues }: StepFormProps) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
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
        <ExpressionTools field={`steps.${index}.config.data`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "data")} />
      </label>
    </div>
  );
}

export function ConditionalStepForm({ index, register, errors, disabled, setValue, getValues }: StepFormProps) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Expression
          <input disabled={disabled} placeholder="{{trigger.body.priority}}" {...register(`steps.${index}.config.left`)} />
          <ExpressionTools field={`steps.${index}.config.left`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
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
          <ExpressionTools field={`steps.${index}.config.right`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        </label>
      </div>
      <label className="workflow-checkbox">
        <input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.skipNextOnFalse`)} />
        Skip next step when false
      </label>
    </div>
  );
}

function ExpressionTools({
  field,
  entries,
  previousKeys,
  disabled,
  getValues,
  setValue
}: {
  field: `steps.${number}.config.${string}`;
  entries: ReturnType<typeof catalogForSteps>;
  previousKeys: string[];
  disabled: boolean;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
}) {
  return (
    <>
      <VariablePicker field={field} entries={entries} disabled={disabled} getValues={getValues} setValue={setValue} />
      <ExpressionPreview value={getValues(field as any)} availableStepKeys={previousKeys} />
    </>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? <span className="field-error">{message}</span> : null;
}

function configError(errors: FieldErrors<WorkflowEditorFormValue>, index: number, key: string) {
  const config = errors.steps?.[index]?.config as Record<string, { message?: string }> | undefined;
  return config?.[key]?.message;
}
