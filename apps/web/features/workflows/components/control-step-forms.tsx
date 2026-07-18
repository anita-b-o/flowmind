"use client";

import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { catalogForSteps } from "../expressions";
import type { WorkflowEditorFormValue } from "../workflow-builder";
import { ExpressionPreview } from "./expression-preview";
import { VariablePicker } from "./variable-picker";

type Props = {
  index: number;
  register: UseFormRegister<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  disabled: boolean;
};

export function IfStepForm({ index, register, errors, disabled, setValue, getValues }: Props) {
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
        </label>
        <label>
          Compare with
          <input disabled={disabled} {...register(`steps.${index}.config.right`)} />
          <ExpressionTools field={`steps.${index}.config.right`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        </label>
        <TargetSelect label="True branch" field="trueStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "trueStepKey")} />
        <TargetSelect label="False branch" field="falseStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "falseStepKey")} />
      </div>
    </div>
  );
}

export function SwitchStepForm({ index, register, errors, disabled, setValue, getValues }: Props) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  const cases = (getValues(`steps.${index}.config.cases`) as Array<Record<string, unknown>> | undefined) ?? [];
  function updateCases(next: Array<Record<string, unknown>>) {
    setValue(`steps.${index}.config.cases`, next, { shouldDirty: true, shouldValidate: true });
  }
  function removeCase(caseIndex: number) {
    const entry = cases[caseIndex];
    if (entry?.stepKey && !window.confirm("Remove this case and its connected branch?")) return;
    updateCases(cases.filter((_, idx) => idx !== caseIndex));
  }
  function moveCase(caseIndex: number, direction: -1 | 1) {
    const nextIndex = caseIndex + direction;
    if (nextIndex < 0 || nextIndex >= cases.length) return;
    const next = [...cases];
    const [item] = next.splice(caseIndex, 1);
    next.splice(nextIndex, 0, item);
    updateCases(next);
  }
  return (
    <div className="stack">
      <label>
        Switch value
        <input disabled={disabled} placeholder="{{trigger.body.priority}}" {...register(`steps.${index}.config.value`)} />
        <ExpressionTools field={`steps.${index}.config.value`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "value")} />
      </label>
      {cases.map((entry, caseIndex) => (
        <div className="workflow-form-grid" key={String(entry.key ?? caseIndex)}>
          <label>
            Case key
            <input
              disabled={disabled}
              value={String(entry.key ?? "")}
              onChange={(event) => updateCases(cases.map((item, idx) => (idx === caseIndex ? { ...item, key: event.target.value } : item)))}
            />
          </label>
          <label>
            Match
            <input
              disabled={disabled}
              value={String(entry.match ?? "")}
              onChange={(event) => updateCases(cases.map((item, idx) => (idx === caseIndex ? { ...item, match: event.target.value } : item)))}
            />
          </label>
          <label>
            Branch
            <select
              disabled={disabled}
              value={String(entry.stepKey ?? "")}
              onChange={(event) => updateCases(cases.map((item, idx) => (idx === caseIndex ? { ...item, stepKey: event.target.value } : item)))}
            >
              <option value="">Select target</option>
              {targetOptions(getValues, index).map((step) => (
                <option key={step.key} value={step.key}>
                  {step.name || step.key}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={disabled || caseIndex === 0} onClick={() => moveCase(caseIndex, -1)}>
            Move up
          </button>
          <button type="button" disabled={disabled || caseIndex === cases.length - 1} onClick={() => moveCase(caseIndex, 1)}>
            Move down
          </button>
          <button type="button" disabled={disabled || cases.length <= 1} onClick={() => removeCase(caseIndex)}>
            Remove case
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => updateCases([...cases, { key: `case_${cases.length + 1}`, label: `Case ${cases.length + 1}`, match: "", stepKey: "" }])}>
        Add case
      </button>
      <TargetSelect label="Default branch" field="defaultStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "defaultStepKey")} />
    </div>
  );
}

export function DelayStepForm({ index, register, errors, disabled, setValue, getValues }: Props) {
  const entries = catalogForSteps(getValues("steps"), index);
  return (
    <label>
      Duration
      <input disabled={disabled} placeholder="30 seconds" {...register(`steps.${index}.config.duration`)} />
      <VariablePicker field={`steps.${index}.config.duration`} entries={entries} disabled={disabled} getValues={getValues} setValue={setValue} />
      <ExpressionPreview value={getValues(`steps.${index}.config.duration` as any)} availableStepKeys={getValues("steps").slice(0, index).map((step) => step.key)} />
      <FieldError message={configError(errors, index, "duration")} />
    </label>
  );
}

export function WaitUntilStepForm({ index, register, errors, disabled, setValue, getValues }: Props) {
  const entries = catalogForSteps(getValues("steps"), index);
  return (
    <label>
      Timestamp
      <input disabled={disabled} placeholder="2026-07-16T12:00:00.000Z" {...register(`steps.${index}.config.timestamp`)} />
      <VariablePicker field={`steps.${index}.config.timestamp`} entries={entries} disabled={disabled} getValues={getValues} setValue={setValue} />
      <ExpressionPreview value={getValues(`steps.${index}.config.timestamp` as any)} availableStepKeys={getValues("steps").slice(0, index).map((step) => step.key)} />
      <FieldError message={configError(errors, index, "timestamp")} />
    </label>
  );
}

export function ForEachStepForm({ index, register, errors, disabled, setValue, getValues }: Props) {
  const entries = catalogForSteps(getValues("steps"), index);
  const previousKeys = getValues("steps").slice(0, index).map((step) => step.key);
  return (
    <div className="stack">
      <label>
        Source
        <input disabled={disabled} placeholder="{{steps.transform.output}}" {...register(`steps.${index}.config.source`)} />
        <ExpressionTools field={`steps.${index}.config.source`} entries={entries} previousKeys={previousKeys} disabled={disabled} getValues={getValues} setValue={setValue} />
        <FieldError message={configError(errors, index, "source")} />
      </label>
      <div className="workflow-form-grid">
        <label>Item alias <input disabled={disabled} placeholder="record" {...register(`steps.${index}.config.itemVariable`)} /></label>
        <label>Index alias <input disabled={disabled} placeholder="position" {...register(`steps.${index}.config.indexVariable`)} /></label>
        <label>Max items <input type="number" min={0} max={1000} disabled={disabled} {...register(`steps.${index}.config.maxItems`, { valueAsNumber: true })} /></label>
        <label>Mode <select disabled {...register(`steps.${index}.config.mode`)}><option value="SEQUENTIAL">Sequential</option></select></label>
        <label>Concurrency <input type="number" value={1} disabled aria-label="Concurrency" /></label>
        <label><input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.continueOnError`)} /> Continue on error</label>
        <label><input type="checkbox" disabled={disabled} {...register(`steps.${index}.config.collectResults`)} /> Collect results</label>
        <label>Max collected results <input type="number" min={0} max={100} disabled={disabled} {...register(`steps.${index}.config.maxResults`, { valueAsNumber: true })} /></label>
      </div>
      <p className="muted">Body expressions can use <code>{"{{item}}"}</code>, <code>{"{{index}}"}</code>, and configured aliases under <code>variables.*</code>. Connect the Body and Done handles on the canvas.</p>
    </div>
  );
}

export function TryCatchStepForm({ index, register, errors, disabled, getValues }: Props) {
  return (
    <div className="stack">
      <div className="workflow-form-grid">
        <TargetSelect label="Body" field="bodyStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "bodyStepKey")} />
        <TargetSelect label="Catch" field="catchStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "catchStepKey")} />
        <TargetSelect label="Finally (optional)" field="finallyStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "finallyStepKey")} />
        <TargetSelect label="Done" field="doneStepKey" index={index} register={register} getValues={getValues} disabled={disabled} error={configError(errors, index, "doneStepKey")} />
      </div>
      <p className="muted">Catch expressions can use <code>{"{{error.message}}"}</code>, <code>{"{{error.category}}"}</code>, <code>{"{{error.code}}"}</code>, and <code>{"{{error.stepKey}}"}</code>.</p>
    </div>
  );
}

function TargetSelect({
  label,
  field,
  index,
  register,
  getValues,
  disabled,
  error
}: {
  label: string;
  field: string;
  index: number;
  register: UseFormRegister<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  disabled: boolean;
  error?: string;
}) {
  return (
    <label>
      {label}
      <select disabled={disabled} {...register(`steps.${index}.config.${field}` as any)}>
        <option value="">Select target</option>
        {targetOptions(getValues, index).map((step) => (
          <option key={step.key} value={step.key}>
            {step.name || step.key}
          </option>
        ))}
      </select>
      <FieldError message={error} />
    </label>
  );
}

function targetOptions(getValues: UseFormGetValues<WorkflowEditorFormValue>, index: number) {
  return getValues("steps").slice(index + 1).filter((step) => step.key);
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

function FieldError({ message }: { message?: string }) {
  return message ? <span className="field-error">{message}</span> : null;
}

function configError(errors: FieldErrors<WorkflowEditorFormValue>, index: number, key: string) {
  const config = errors.steps?.[index]?.config as Record<string, { message?: string }> | undefined;
  return config?.[key]?.message;
}
