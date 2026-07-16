"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorMessage } from "../../../components/error-message";
import { StatusBadge } from "../../../components/status-badge";
import { useActivateWorkflowVersion, useCreateWorkflowVersion } from "../hooks";
import type { WorkflowDetail, WorkflowVersion } from "../types";
import { emptyStep, formFromVersion, STEP_TYPES, toWorkflowDefinition, workflowEditorSchema, type StepFormValue, type WorkflowEditorFormValue } from "../workflow-builder";
import { StepCard } from "./step-card";

export function WorkflowEditor({ workflow, onRefresh }: { workflow: WorkflowDetail; onRefresh: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedVersionId = searchParams.get("version");
  const latestVersion = workflow.versions.at(-1);
  const initialVersion = workflow.versions.find((version) => version.id === requestedVersionId) ?? latestVersion;
  const [selectedVersionId, setSelectedVersionId] = useState(initialVersion?.id ?? "draft");
  const [activateVersionId, setActivateVersionId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [typeNotice, setTypeNotice] = useState<string | null>(null);
  const [stepTypeToAdd, setStepTypeToAdd] = useState<StepFormValue["type"]>("http_request");
  const selectedVersion = workflow.versions.find((version) => version.id === selectedVersionId);
  const versionForForm = selectedVersion ?? latestVersion;
  const isLatest = Boolean(selectedVersion && latestVersion && selectedVersion.id === latestVersion.id);
  const isEditable = !selectedVersion || isLatest;
  const createVersion = useCreateWorkflowVersion(workflow.id);
  const activateVersion = useActivateWorkflowVersion(workflow.id);
  const defaults = useMemo(() => formFromVersion(workflow, versionForForm), [workflow, versionForForm]);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    getValues,
    trigger,
    watch,
    formState: { errors, isDirty, isValid }
  } = useForm<WorkflowEditorFormValue>({
    resolver: zodResolver(workflowEditorSchema),
    mode: "onChange",
    defaultValues: defaults
  });
  const { fields, append, remove, insert, move } = useFieldArray({ control, name: "steps" });
  const steps = watch("steps");

  useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (isDirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [isDirty]);

  async function submit(values: WorkflowEditorFormValue) {
    const version = (await createVersion.mutateAsync(toWorkflowDefinition(values))) as WorkflowVersion;
    setSelectedVersionId(version.id);
    router.replace(`${pathname}?version=${version.id}`);
    reset(formFromVersion(workflow, version));
    onRefresh();
  }

  async function confirmActivation() {
    if (!activateVersionId) {
      return;
    }
    await activateVersion.mutateAsync(activateVersionId);
    setActivateVersionId(null);
    onRefresh();
  }

  function selectVersion(versionId: string) {
    if (isDirty && !window.confirm("Discard local draft changes?")) {
      return;
    }
    setSelectedVersionId(versionId);
    router.replace(versionId === "draft" ? pathname : `${pathname}?version=${versionId}`);
  }

  async function addStep(type = stepTypeToAdd) {
    append(emptyStep(fields.length, type), { shouldFocus: false });
    await trigger();
  }

  function duplicateStep(index: number, step: StepFormValue) {
    insert(index + 1, step);
  }

  function dropOn(index: number) {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      return;
    }
    move(dragIndex, index);
    setDragIndex(null);
  }

  return (
    <div className="workflow-layout">
      <aside className="panel stack workflow-history">
        <div>
          <h2>Versions</h2>
          <p className="muted">Only the latest version is editable.</p>
        </div>
        <button type="button" className={selectedVersionId === "draft" ? "version-item active" : "version-item"} onClick={() => selectVersion("draft")}>
          <strong>Local draft</strong>
          <span className="muted">{isDirty ? "Unsaved changes" : "Editable draft"}</span>
        </button>
        {workflow.versions.map((version) => (
          <button
            key={version.id}
            type="button"
            className={selectedVersionId === version.id ? "version-item active" : "version-item"}
            onClick={() => selectVersion(version.id)}
          >
            <strong>v{version.versionNumber}</strong>
            <span>{version.status === "ACTIVE" ? "Active" : version.status === "DRAFT" ? "Draft" : "Archived"}</span>
            <span className="muted">{formatDate(version.createdAt)}</span>
            <span className="muted">{version.createdBy?.name ?? version.createdBy?.email ?? "Unknown creator"}</span>
          </button>
        ))}
      </aside>

      <form className="stack" onSubmit={handleSubmit(submit)}>
        <section className="panel stack">
          <div className="workflow-title-row">
            <div>
              <h1>{workflow.name}</h1>
              <div className="workflow-badges">
                <StatusBadge status={workflow.status} />
                {selectedVersion && <span className="status-badge">v{selectedVersion.versionNumber}</span>}
                {workflow.activeVersionId === selectedVersion?.id && <span className="status-badge">Active version</span>}
                {isDirty && <span className="status-badge">Unsaved draft</span>}
              </div>
            </div>
            {selectedVersion && workflow.activeVersionId !== selectedVersion.id && (
              <button type="button" onClick={() => setActivateVersionId(selectedVersion.id)} disabled={activateVersion.isPending}>
                Activate version
              </button>
            )}
          </div>
          {createVersion.error && <ErrorMessage error={createVersion.error} onRetry={() => createVersion.reset()} />}
          {activateVersion.error && <ErrorMessage error={activateVersion.error} onRetry={() => activateVersion.reset()} />}
          {typeNotice && <p className="form-warning">{typeNotice}</p>}
          {!isEditable && <p className="form-warning">This version is read-only. Open the latest version or the local draft to edit.</p>}
          <div className="workflow-form-grid">
            <label>
              Workflow name
              <input disabled={!isEditable} {...register("name")} />
              {errors.name && <span className="field-error">{errors.name.message}</span>}
            </label>
            <label>
              Description
              <input disabled={!isEditable} {...register("description")} />
            </label>
          </div>
        </section>

        <section className="panel stack">
          <div className="workflow-title-row">
            <div>
              <h2>Steps</h2>
              <p className="muted">Drag cards to order the form-based flow. Routing fields can branch to later steps.</p>
            </div>
            <div className="workflow-actions">
              <select
                aria-label="Step type to add"
                disabled={!isEditable}
                value={stepTypeToAdd}
                onChange={(event) => setStepTypeToAdd(event.target.value as StepFormValue["type"])}
              >
                {STEP_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!isEditable} onClick={() => void addStep()}>
                Add step
              </button>
            </div>
          </div>
          {!fields.length && <p className="muted">No steps yet.</p>}
          {fields.map((field, index) => (
            <StepCard
              key={field.id}
              index={index}
              step={steps?.[index] ?? (field as StepFormValue)}
              disabled={!isEditable}
              register={register}
              errors={errors}
              setValue={(name, value, options) => {
                if (String(name).endsWith(".type")) {
                  setTypeNotice("Step type changed. Incompatible configuration fields were removed.");
                }
                setValue(name, value, options);
              }}
              getValues={getValues}
              onRemove={() => remove(index)}
              onDuplicate={(step) => duplicateStep(index, step)}
              onDragStart={() => setDragIndex(index)}
              onDragOver={() => undefined}
              onDrop={() => dropOn(index)}
            />
          ))}
        </section>

        <section className="panel workflow-title-row">
          <div>
            <strong>{isValid ? "Definition valid" : "Definition has errors"}</strong>
            <p className="muted">{isDirty ? "Local draft changes are not saved to the backend." : "No local changes."}</p>
          </div>
          <div className="workflow-actions">
            <button type="button" disabled={!isEditable || !isDirty} onClick={() => reset(defaults)}>
              Discard draft
            </button>
            <button type="submit" disabled={!isEditable || !isValid || createVersion.isPending}>
              {createVersion.isPending ? "Creating..." : "Create version"}
            </button>
          </div>
        </section>
      </form>

      <ConfirmDialog
        open={Boolean(activateVersionId)}
        title="Activate workflow version"
        description="This will make the selected version the active workflow version. It will not run automatically."
        confirmLabel={activateVersion.isPending ? "Activating..." : "Activate version"}
        onCancel={() => setActivateVersionId(null)}
        onConfirm={confirmActivation}
      />
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
