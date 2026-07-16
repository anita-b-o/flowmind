"use client";

import type { FieldErrors, UseFormRegister } from "react-hook-form";
import { STEP_TYPES, defaultTimeout, keepCompatibleConfig, type WorkflowEditorFormValue } from "../workflow-builder";
import type { StepType } from "../types";
import { FieldError } from "./step-forms";

export function StepHeader({
  index,
  expanded,
  disabled,
  register,
  errors,
  onToggle,
  onTypeChange,
  onDuplicate,
  onRemove
}: {
  index: number;
  expanded: boolean;
  disabled: boolean;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  onToggle: () => void;
  onTypeChange: (type: StepType) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="step-header">
      <button type="button" className="icon-button" onClick={onToggle} aria-label={expanded ? "Collapse step" : "Expand step"}>
        {expanded ? "v" : ">"}
      </button>
      <div className="workflow-form-grid step-header-fields">
        <label>
          Name
          <input disabled={disabled} {...register(`steps.${index}.name`)} />
          <FieldError message={errors.steps?.[index]?.name?.message} />
        </label>
        <label>
          Key
          <input disabled={disabled} {...register(`steps.${index}.key`)} />
          <FieldError message={errors.steps?.[index]?.key?.message} />
        </label>
        <label>
          Type
          <select
            disabled={disabled}
            {...register(`steps.${index}.type`)}
            onChange={(event) => onTypeChange(event.target.value as StepType)}
          >
            {STEP_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="step-actions">
        <button type="button" disabled={disabled} onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" disabled={disabled} onClick={onRemove}>
          Delete
        </button>
      </div>
    </div>
  );
}

export function compatibleTypePatch(type: StepType, currentConfig: Record<string, unknown>) {
  return { config: keepCompatibleConfig(type, currentConfig), timeoutSeconds: defaultTimeout(type) };
}
