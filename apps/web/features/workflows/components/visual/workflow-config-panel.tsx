"use client";

import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { RetryEditor } from "../retry-editor";
import { StepForm } from "../step-forms";
import { TimeoutEditor } from "../timeout-editor";
import type { WorkflowDraftModel } from "../../draft-model";
import type { StepType } from "../../types";
import { keepCompatibleConfig, type WorkflowEditorFormValue } from "../../workflow-builder";

export function WorkflowConfigPanel({
  draft,
  register,
  errors,
  setValue,
  getValues,
  onRemove,
  onDuplicate
}: {
  draft: WorkflowDraftModel;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  onRemove: (key: string) => void;
  onDuplicate: (key: string) => void;
}) {
  const selectedKey = draft.selectedStepKey;
  const index = selectedKey ? getValues("steps").findIndex((step) => step.key === selectedKey) : -1;
  const step = index >= 0 ? getValues(`steps.${index}`) : undefined;
  if (!selectedKey || !step) {
    return (
      <aside className="workflow-config-panel stack">
        <h3>Configuration</h3>
        <p className="muted">Select a node to edit its settings.</p>
      </aside>
    );
  }

  function changeType(type: StepType) {
    if (!window.confirm("Changing this node type removes incompatible configuration fields.")) return;
    const currentConfig = getValues(`steps.${index}.config`);
    setValue(`steps.${index}.type`, type, { shouldDirty: true, shouldValidate: true });
    setValue(`steps.${index}.config`, keepCompatibleConfig(type, currentConfig), { shouldDirty: true, shouldValidate: true });
  }

  const stepIssues = draft.validation.issues.filter((issue) => issue.stepKey === selectedKey);
  return (
    <aside className="workflow-config-panel stack" aria-label="Selected node configuration">
      <div className="workflow-title-row">
        <div>
          <h3>Configuration</h3>
          <p className="muted">{selectedKey}</p>
        </div>
        <div className="workflow-actions">
          <button type="button" disabled={draft.readOnly} onClick={() => onDuplicate(selectedKey)}>
            Duplicate
          </button>
          <button type="button" disabled={draft.readOnly} onClick={() => onRemove(selectedKey)}>
            Delete
          </button>
        </div>
      </div>

      <section className="stack">
        <h4>General</h4>
        <div className="workflow-form-grid">
          <label>
            Name
            <input disabled={draft.readOnly} {...register(`steps.${index}.name`)} />
          </label>
          <label>
            Step key
            <input disabled={draft.readOnly} {...register(`steps.${index}.key`)} />
          </label>
          <label>
            Type
            <select disabled={draft.readOnly} value={step.type} onChange={(event) => changeType(event.target.value as StepType)}>
              {["http_request", "ai_classification", "ai_structured_extraction", "ai_summary", "email_notification", "database_record", "if", "switch", "delay", "wait_until", "conditional"].map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="stack">
        <h4>Configuration</h4>
        <StepForm index={index} type={step.type} register={register} errors={errors} disabled={draft.readOnly} setValue={setValue} getValues={getValues} />
      </section>

      <section className="stack">
        <h4>Retry and Timeout</h4>
        <div className="workflow-form-grid">
          <RetryEditor index={index} register={register} disabled={draft.readOnly} />
          <TimeoutEditor index={index} register={register} disabled={draft.readOnly} />
        </div>
      </section>

      <section className="stack" aria-live="polite">
        <h4>Validation</h4>
        {!stepIssues.length && <p className="muted">No node issues.</p>}
        {stepIssues.map((issue) => (
          <p key={`${issue.code}-${issue.handle ?? ""}`} className={issue.severity === "error" ? "field-error" : "form-warning"}>
            {issue.message}
          </p>
        ))}
      </section>
    </aside>
  );
}
