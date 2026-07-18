"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { useConnections } from "../../connections/hooks";
import { useDataStores } from "../../data-stores/hooks";
import type { WorkflowEditorFormValue } from "../workflow-builder";
import { catalogForSteps } from "../expressions";
import { ExpressionPreview } from "./expression-preview";
import { VariablePicker } from "./variable-picker";
import { DelayStepForm, ForEachStepForm, IfStepForm, SwitchStepForm, WaitUntilStepForm } from "./control-step-forms";

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
  if (type.startsWith("data_store_")) {
    return <DataStoreStepForm index={index} type={type} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "transform") {
    return <TransformStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type.endsWith("_variable")) {
    return <VariableStepForm index={index} type={type} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "if") {
    return <IfStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "switch") {
    return <SwitchStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
  }
  if (type === "for_each") {
    return <ForEachStepForm index={index} register={register} errors={errors} disabled={disabled} setValue={setValue} getValues={getValues} />;
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

export function DataStoreStepForm({ index, type, register, errors, disabled, setValue, getValues }: StepFormProps & { type: string }) {
  const dataStores = useDataStores();
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Data Store
          <select disabled={disabled || dataStores.isLoading} {...register(`steps.${index}.config.dataStoreId`)}>
            <option value="">Select a Data Store</option>
            {dataStores.data?.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <FieldError message={configError(errors, index, "dataStoreId") ?? configError(errors, index, "dataStoreName")} />
        </label>
        {["data_store_get_record", "data_store_upsert_record", "data_store_delete_record", "data_store_exists_record"].includes(type) && (
          <label>
            Key
            <input disabled={disabled} {...register(`steps.${index}.config.key`)} />
            <ExpressionTools field={`steps.${index}.config.key`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
            <FieldError message={configError(errors, index, "key")} />
          </label>
        )}
        {(type === "data_store_count_records" || type === "data_store_list_records") && (
          <label>
            Key prefix
            <input disabled={disabled} {...register(`steps.${index}.config.keyPrefix`)} />
            <ExpressionTools field={`steps.${index}.config.keyPrefix`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          </label>
        )}
      </div>
      {type === "data_store_get_record" && (
        <label className="workflow-checkbox">
          <input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.failIfMissing`)} />
          Fail if missing
        </label>
      )}
      {type === "data_store_upsert_record" && (
        <>
          <div className="workflow-form-grid">
            <label>
              Mode
              <select disabled={disabled} {...register(`steps.${index}.config.mode`)}>
                <option value="replace">Replace</option>
                <option value="merge">Merge object</option>
              </select>
            </label>
            <label>
              TTL seconds
              <input type="number" min={0} disabled={disabled} {...register(`steps.${index}.config.ttlSeconds`)} />
            </label>
            <label className="workflow-checkbox">
              <input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.optimisticConcurrency`)} />
              Optimistic concurrency
            </label>
            <label>
              Expected version
              <input type="number" min={1} disabled={disabled} {...register(`steps.${index}.config.expectedVersion`)} />
            </label>
          </div>
          <label>
            Value
            <textarea rows={6} disabled={disabled} {...register(`steps.${index}.config.value`)} />
            <ExpressionTools field={`steps.${index}.config.value`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
            <FieldError message={configError(errors, index, "value")} />
          </label>
          <label>
            Metadata
            <textarea rows={3} disabled={disabled} {...register(`steps.${index}.config.metadata`)} />
            <ExpressionTools field={`steps.${index}.config.metadata`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
            <FieldError message={configError(errors, index, "metadata")} />
          </label>
        </>
      )}
      {type === "data_store_list_records" && (
        <div className="workflow-form-grid">
          <label>
            Limit
            <input type="number" min={1} max={100} disabled={disabled} {...register(`steps.${index}.config.limit`, { valueAsNumber: true })} />
          </label>
          <label>
            Offset
            <input type="number" min={0} disabled={disabled} {...register(`steps.${index}.config.offset`, { valueAsNumber: true })} />
          </label>
          <label>
            Sort
            <select disabled={disabled} {...register(`steps.${index}.config.sortBy`)}>
              <option value="key">Key</option>
              <option value="createdAt">Created at</option>
              <option value="updatedAt">Updated at</option>
            </select>
          </label>
          <label>
            Direction
            <select disabled={disabled} {...register(`steps.${index}.config.direction`)}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export function VariableStepForm({ index, type, register, errors, disabled, setValue, getValues }: StepFormProps & { type: string }) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  const [valueKind, setValueKind] = useState(String(getValues(`steps.${index}.config.valueKind`) ?? "literal"));
  const [valueType, setValueType] = useState(String(getValues(`steps.${index}.config.valueType`) ?? "string"));
  const valueKindField = register(`steps.${index}.config.valueKind`);
  const valueTypeField = register(`steps.${index}.config.valueType`);
  const hasValue = type === "set_variable" || type === "append_variable";
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Scope
          <select disabled={disabled} {...register(`steps.${index}.config.scope`)}>
            <option value="execution">Execution</option>
            <option value="workflow">Workflow</option>
          </select>
          <FieldError message={configError(errors, index, "scope")} />
        </label>
        <label>
          Name
          <input disabled={disabled} placeholder="customer_id" {...register(`steps.${index}.config.name`)} />
          <FieldError message={configError(errors, index, "name")} />
        </label>
        {type === "increment_variable" && (
          <label>
            Amount
            <input type="number" step="any" disabled={disabled} {...register(`steps.${index}.config.amount`, { valueAsNumber: true })} />
            <FieldError message={configError(errors, index, "amount")} />
          </label>
        )}
      </div>
      {type === "increment_variable" && (
        <label>
          Amount expression
          <input disabled={disabled} placeholder="{{trigger.body.delta}}" {...register(`steps.${index}.config.amountExpression`)} />
          <ExpressionTools field={`steps.${index}.config.amountExpression`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        </label>
      )}
      {hasValue && (
        <>
          <div className="workflow-form-grid">
            <label>
              Value source
              <select
                disabled={disabled}
                {...valueKindField}
                onChange={(event) => {
                  void valueKindField.onChange(event);
                  setValueKind(event.target.value);
                }}
              >
                <option value="literal">Literal</option>
                <option value="expression">Expression</option>
              </select>
            </label>
            {valueKind !== "expression" && (
              <label>
                Value type
                <select
                  disabled={disabled}
                  {...valueTypeField}
                  onChange={(event) => {
                    void valueTypeField.onChange(event);
                    setValueType(event.target.value);
                  }}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="null">Null</option>
                  <option value="json">JSON</option>
                </select>
              </label>
            )}
          </div>
          {valueKind === "expression" ? (
            <label>
              Expression
              <input disabled={disabled} placeholder="{{trigger.body.value}}" {...register(`steps.${index}.config.expression`)} />
              <ExpressionTools field={`steps.${index}.config.expression`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
              <FieldError message={configError(errors, index, "expression")} />
            </label>
          ) : (
            <label>
              Value
              {valueType === "json" ? <textarea rows={5} disabled={disabled} {...register(`steps.${index}.config.value`)} /> : <input disabled={disabled} {...register(`steps.${index}.config.value`)} />}
              <FieldError message={configError(errors, index, "value")} />
            </label>
          )}
        </>
      )}
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

export function TransformStepForm({ index, register, errors, disabled, setValue, getValues }: StepFormProps) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  const [mode, setMode] = useState(String(getValues(`steps.${index}.config.mode`) ?? "OBJECT"));
  const [fieldRows, setFieldRows] = useState(() => fieldsFromText(String(getValues(`steps.${index}.config.fields`) ?? "{}"), String(getValues(`steps.${index}.config.fieldsUi`) ?? "")));
  const fieldsText = useMemo(() => serializeFieldRows(fieldRows), [fieldRows]);
  const modeField = register(`steps.${index}.config.mode`);
  function updateFields(rows: FieldRow[]) {
    setFieldRows(rows);
    setValue(`steps.${index}.config.fieldsUi`, JSON.stringify(rows), { shouldDirty: true });
    if (!hasDuplicateFieldKeys(rows)) {
      setValue(`steps.${index}.config.fields`, serializeFieldRows(rows), { shouldDirty: true, shouldValidate: true });
    }
  }
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <label>
          Mode
          <select
            disabled={disabled}
            {...modeField}
            onChange={(event) => {
              void modeField.onChange(event);
              setMode(event.target.value);
            }}
          >
            <option value="OBJECT">Object</option>
            <option value="PICK">Pick</option>
            <option value="OMIT">Omit</option>
            <option value="MAP_ARRAY">Map array</option>
            <option value="FILTER_ARRAY">Filter array</option>
            <option value="MERGE">Merge</option>
          </select>
          <FieldError message={configError(errors, index, "mode")} />
        </label>
        <label>
          Output type
          <select disabled={disabled} {...register(`steps.${index}.config.outputType`)}>
            {["AUTO", "OBJECT", "ARRAY", "STRING", "NUMBER", "BOOLEAN"].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <FieldError message={configError(errors, index, "outputType")} />
        </label>
      </div>
      {mode === "OBJECT" && (
        <div className="stack" aria-label="Transform fields">
          <strong>Fields</strong>
          {fieldRows.map((row, rowIndex) => {
            const duplicate = row.key.trim() && fieldRows.findIndex((entry) => entry.key.trim() === row.key.trim()) !== rowIndex;
            const dangerous = ["__proto__", "prototype", "constructor"].includes(row.key.trim());
            return (
              <div className="workflow-form-grid" key={rowIndex}>
                <label>
                  Name
                  <input
                    aria-label="Field name"
                    disabled={disabled}
                    value={row.key}
                    onChange={(event) => updateFields(fieldRows.map((entry, idx) => (idx === rowIndex ? { ...entry, key: event.target.value } : entry)))}
                  />
                  {duplicate && <FieldError message="Field names must be unique." />}
                  {dangerous && <FieldError message="This field name is not allowed." />}
                </label>
                <label>
                  Value type
                  <select aria-label="Field value type" disabled={disabled} value={row.kind} onChange={(event) => updateFields(fieldRows.map((entry, idx) => (idx === rowIndex ? { ...entry, kind: event.target.value } : entry)))}>
                    <option value="literal">Literal</option>
                    <option value="expression">Expression</option>
                  </select>
                </label>
                <label>
                  Value
                  <input
                    aria-label="Field value"
                    disabled={disabled}
                    placeholder={row.kind === "expression" ? "{{trigger.body.name}}" : "text, 123, true, null"}
                    value={row.value}
                    onChange={(event) => updateFields(fieldRows.map((entry, idx) => (idx === rowIndex ? { ...entry, value: event.target.value } : entry)))}
                  />
                </label>
                <button type="button" disabled={disabled || fieldRows.length <= 1} onClick={() => updateFields(fieldRows.filter((_, idx) => idx !== rowIndex))}>
                  Remove
                </button>
              </div>
            );
          })}
          <button type="button" disabled={disabled} onClick={() => updateFields([...fieldRows, { key: `field_${fieldRows.length + 1}`, kind: "expression", value: "{{trigger.body}}" }])}>
            Add field
          </button>
          <input type="hidden" {...register(`steps.${index}.config.fields`)} value={fieldsText} />
          <span className="muted">Use literal JSON scalars or safe expressions. For STRING, NUMBER, or BOOLEAN output, keep exactly one field named value. Nested objects can be restored from saved workflows.</span>
          <FieldError message={configError(errors, index, "fields")} />
        </div>
      )}
      {(mode === "PICK" || mode === "OMIT" || mode === "MAP_ARRAY" || mode === "FILTER_ARRAY") && (
        <label>
          Source
          <input disabled={disabled} placeholder="{{trigger.body}}" {...register(`steps.${index}.config.source`)} />
          <ExpressionTools field={`steps.${index}.config.source`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <FieldError message={configError(errors, index, "source")} />
        </label>
      )}
      {(mode === "PICK" || mode === "OMIT") && (
        <label>
          Paths
          <textarea rows={4} disabled={disabled} placeholder="id,name,profile.email" {...register(`steps.${index}.config.paths`)} />
          <span className="muted">Comma or newline separated paths. Unsafe keys are blocked.</span>
          <FieldError message={configError(errors, index, "paths")} />
        </label>
      )}
      {mode === "MAP_ARRAY" && (
        <label>
          Template
          <textarea rows={8} disabled={disabled} placeholder='{"id":"{{item.id}}","row":"{{index}}"}' {...register(`steps.${index}.config.template`)} />
          <ExpressionTools field={`steps.${index}.config.template`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <span className="muted">Each item exposes item and index.</span>
          <FieldError message={configError(errors, index, "template")} />
        </label>
      )}
      {mode === "FILTER_ARRAY" && (
        <label>
          Condition
          <input disabled={disabled} placeholder="{{item.active}}" {...register(`steps.${index}.config.condition`)} />
          <ExpressionTools field={`steps.${index}.config.condition`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
          <span className="muted">Must resolve to true or false for each item. item and index are available.</span>
          <FieldError message={configError(errors, index, "condition")} />
        </label>
      )}
      {mode === "MERGE" && (
        <>
          <label>
            Sources
            <textarea rows={6} disabled={disabled} placeholder='["{{trigger.body}}","{{steps.lookup.output}}"]' {...register(`steps.${index}.config.mergeSources`)} />
            <ExpressionTools field={`steps.${index}.config.mergeSources`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
            <FieldError message={configError(errors, index, "mergeSources")} />
          </label>
          <label>
            Conflict policy
            <select disabled={disabled} {...register(`steps.${index}.config.conflictPolicy`)}>
              <option value="LAST_WINS">Last wins</option>
              <option value="FIRST_WINS">First wins</option>
              <option value="ERROR">Error</option>
            </select>
            <FieldError message={configError(errors, index, "conflictPolicy")} />
          </label>
        </>
      )}
      <pre className="workflow-config-preview" aria-label="Transform configuration preview">
        {JSON.stringify({ mode, outputType: getValues(`steps.${index}.config.outputType`) ?? "AUTO" }, null, 2)}
      </pre>
    </div>
  );
}

type FieldRow = { key: string; kind: string; value: string };

function fieldsFromText(value: string, uiValue = ""): FieldRow[] {
  const uiRows = rowsFromUiText(uiValue);
  if (uiRows.length) return uiRows;
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [{ key: "result", kind: "expression", value: "{{trigger.body}}" }];
    const rows = Object.entries(parsed).map(([key, entry]) => ({
      key,
      kind: typeof entry === "string" && entry.includes("{{") ? "expression" : "literal",
      value: typeof entry === "string" && entry.includes("{{") ? entry : JSON.stringify(entry)
    }));
    return rows.length ? rows : [{ key: "result", kind: "expression", value: "{{trigger.body}}" }];
  } catch {
    return [{ key: "result", kind: "expression", value: "{{trigger.body}}" }];
  }
}

function rowsFromUiText(value: string): FieldRow[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        key: typeof row?.key === "string" ? row.key : "",
        kind: row?.kind === "literal" ? "literal" : "expression",
        value: typeof row?.value === "string" ? row.value : ""
      }))
      .filter((row) => row.key || row.value);
  } catch {
    return [];
  }
}

function serializeFieldRows(rows: FieldRow[]) {
  return JSON.stringify(
    Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.kind === "expression" ? expressionValue(row.value) : literalValue(row.value)])),
    null,
    2
  );
}

function hasDuplicateFieldKeys(rows: FieldRow[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function expressionValue(value: string) {
  return value.includes("{{") ? value : `{{${value.trim()}}}`;
}

function literalValue(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
