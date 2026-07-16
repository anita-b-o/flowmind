"use client";

import type { UseFormRegister } from "react-hook-form";
import type { WorkflowEditorFormValue } from "../workflow-builder";

export function RetryEditor({ index, register, disabled }: { index: number; register: UseFormRegister<WorkflowEditorFormValue>; disabled: boolean }) {
  return (
    <div className="workflow-form-grid">
      <label>
        Max attempts
        <input type="number" min={1} max={5} disabled={disabled} {...register(`steps.${index}.retryPolicy.maxAttempts`, { valueAsNumber: true })} />
      </label>
      <label>
        Backoff ms
        <input type="number" min={100} max={60000} step={100} disabled={disabled} {...register(`steps.${index}.retryPolicy.backoffMs`, { valueAsNumber: true })} />
      </label>
      <label>
        Strategy
        <select disabled={disabled} {...register(`steps.${index}.retryPolicy.strategy`)}>
          <option value="fixed">Fixed</option>
          <option value="exponential">Exponential</option>
        </select>
      </label>
    </div>
  );
}
