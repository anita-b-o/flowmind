"use client";

import type { UseFormGetValues, UseFormSetValue } from "react-hook-form";
import type { VariableCatalogEntry } from "@automation/expression-engine";
import type { WorkflowEditorFormValue } from "../workflow-builder";

type FieldName = `steps.${number}.config.${string}`;

export function VariablePicker({
  field,
  entries,
  disabled,
  getValues,
  setValue
}: {
  field: FieldName;
  entries: VariableCatalogEntry[];
  disabled: boolean;
  getValues: UseFormGetValues<WorkflowEditorFormValue>;
  setValue: UseFormSetValue<WorkflowEditorFormValue>;
}) {
  function insert(path: string) {
    const current = String(getValues(field as any) ?? "");
    const separator = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
    setValue(field as any, `${current}${separator}{{${path}}}`, { shouldDirty: true, shouldValidate: true });
  }

  return (
    <div className="workflow-actions" style={{ justifyContent: "flex-start" }}>
      <select aria-label="Variable" disabled={disabled || entries.length === 0} defaultValue="" onChange={(event) => event.target.value && insert(event.target.value)}>
        <option value="">Insert variable</option>
        {entries.map((entry) => (
          <option key={entry.path} value={entry.path}>
            {entry.path} ({entry.type})
          </option>
        ))}
      </select>
    </div>
  );
}
