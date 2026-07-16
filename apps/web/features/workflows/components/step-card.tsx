"use client";

import type { FieldErrors, UseFormGetValues, UseFormRegister, UseFormSetValue } from "react-hook-form";
import type { StepType } from "../types";
import { emptyStep, keepCompatibleConfig, type StepFormValue, type WorkflowEditorFormValue } from "../workflow-builder";
import { RetryEditor } from "./retry-editor";
import { StepForm } from "./step-forms";
import { StepHeader } from "./step-header";
import { TimeoutEditor } from "./timeout-editor";

export function StepCard({
  index,
  step,
  disabled,
  register,
  errors,
  setValue,
  getValues,
  onRemove,
  onDuplicate,
  onDragStart,
  onDragOver,
  onDrop
}: {
  index: number;
  step: StepFormValue;
  disabled: boolean;
  register: UseFormRegister<WorkflowEditorFormValue>;
  errors: FieldErrors<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  onRemove: () => void;
  onDuplicate: (step: StepFormValue) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  function toggleExpanded() {
    setValue(`steps.${index}.expanded`, !step.expanded, { shouldDirty: true });
  }

  function changeType(type: StepType) {
    const currentConfig = getValues(`steps.${index}.config`);
    setValue(`steps.${index}.type`, type, { shouldDirty: true, shouldValidate: true });
    setValue(`steps.${index}.config`, keepCompatibleConfig(type, currentConfig), { shouldDirty: true, shouldValidate: true });
    setValue(`steps.${index}.timeoutSeconds`, emptyStep(index, type).timeoutSeconds, { shouldDirty: true, shouldValidate: true });
    window.alert("Step type changed. Incompatible configuration fields were removed.");
  }

  return (
    <article
      className="step-card panel stack"
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <StepHeader
        index={index}
        expanded={step.expanded}
        disabled={disabled}
        register={register}
        errors={errors}
        onToggle={toggleExpanded}
        onTypeChange={changeType}
        onDuplicate={() => onDuplicate({ ...step, id: crypto.randomUUID(), key: `${step.key}_copy`, name: `${step.name} copy`, expanded: true })}
        onRemove={onRemove}
      />
      {step.expanded && (
        <>
          <StepForm index={index} type={step.type} register={register} errors={errors} disabled={disabled} />
          <div className="workflow-form-grid">
            <RetryEditor index={index} register={register} disabled={disabled} />
            <TimeoutEditor index={index} register={register} disabled={disabled} />
          </div>
        </>
      )}
    </article>
  );
}
