"use client";

import { validateExpressionPreview } from "../expressions";

export function ExpressionPreview({ value, availableStepKeys }: { value: unknown; availableStepKeys: string[] }) {
  if (typeof value !== "string" || !value.includes("{{")) return null;
  const preview = validateExpressionPreview(value, availableStepKeys);
  return (
    <div className={preview.valid ? "muted" : "field-error"}>
      {preview.valid ? `Preview: ${formatPreview(preview.result)}` : `Expression error: ${preview.issues?.[0]?.message ?? "Invalid expression"}`}
    </div>
  );
}

function formatPreview(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
