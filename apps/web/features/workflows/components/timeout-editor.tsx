"use client";

import type { UseFormRegister } from "react-hook-form";
import type { WorkflowEditorFormValue } from "../workflow-builder";

export function TimeoutEditor({ index, register, disabled }: { index: number; register: UseFormRegister<WorkflowEditorFormValue>; disabled: boolean }) {
  return (
    <label>
      Timeout seconds
      <input type="number" min={1} max={120} disabled={disabled} {...register(`steps.${index}.timeoutSeconds`, { valueAsNumber: true })} />
    </label>
  );
}
