"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorMessage } from "../../../components/error-message";
import { StatusBadge } from "../../../components/status-badge";
import { draftToFormValue, draftToWorkflowDefinitionDto, formValueToDraft, workflowVersionToDraft } from "../draft-adapters";
import type { WorkflowDraftModel } from "../draft-model";
import { useActivateWorkflowVersion, useCreateWorkflowVersion } from "../hooks";
import type { WorkflowDetail, WorkflowVersion } from "../types";
import { emptyStep, STEP_TYPES, workflowEditorSchema, type StepFormValue, type WorkflowEditorFormValue } from "../workflow-builder";
import { StepCard } from "./step-card";
import { WorkflowVisualEditor } from "./visual/workflow-visual-editor";

type EditorMode = "visual" | "form";

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
  const [mode, setMode] = useState<EditorMode>("visual");
  const selectedVersion = workflow.versions.find((version) => version.id === selectedVersionId);
  const versionForForm = selectedVersion ?? latestVersion;
  const isLatest = Boolean(selectedVersion && latestVersion && selectedVersion.id === latestVersion.id);
  const isEditable = !selectedVersion || isLatest;
  const createVersion = useCreateWorkflowVersion(workflow.id);
  const activateVersion = useActivateWorkflowVersion(workflow.id);
  const initialDraft = useMemo(() => workflowVersionToDraft(workflow, versionForForm, !isEditable), [workflow, versionForForm, isEditable]);
  const [draft, setDraft] = useState<WorkflowDraftModel>(initialDraft);
  const syncingRef = useRef(false);

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
    defaultValues: draftToFormValue(initialDraft)
  });
  const { fields, append, remove, insert, move } = useFieldArray({ control, name: "steps" });
  const steps = watch("steps");

  useEffect(() => {
    setDraft(initialDraft);
    syncingRef.current = true;
    reset(draftToFormValue(initialDraft));
    queueMicrotask(() => {
      syncingRef.current = false;
    });
  }, [initialDraft, reset]);

  useEffect(() => {
    const subscription = watch((value) => {
      if (syncingRef.current || draft.readOnly || !value.name || !Array.isArray(value.steps)) return;
      setDraft((current) => formValueToDraft(value as WorkflowEditorFormValue, current));
    });
    return () => subscription.unsubscribe();
  }, [watch, draft.readOnly]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (isDirty || draft.dirty.semantic || draft.dirty.layout) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [isDirty, draft.dirty.semantic, draft.dirty.layout]);

  function applyDraft(next: WorkflowDraftModel, options: { syncForm?: boolean } = {}) {
    setDraft(next);
    if (options.syncForm !== false) {
      syncingRef.current = true;
      reset(draftToFormValue(next), { keepDirty: true, keepErrors: true });
      queueMicrotask(() => {
        syncingRef.current = false;
      });
    }
  }

  async function submit(values: WorkflowEditorFormValue) {
    const nextDraft = formValueToDraft(values, draft);
    applyDraft(nextDraft, { syncForm: false });
    if (nextDraft.validation.issues.some((issue) => issue.severity === "error")) {
      return;
    }
    const version = (await createVersion.mutateAsync(draftToWorkflowDefinitionDto(nextDraft))) as WorkflowVersion;
    setSelectedVersionId(version.id);
    router.replace(`${pathname}?version=${version.id}`);
    onRefresh();
  }

  async function confirmActivation() {
    if (!activateVersionId) return;
    await activateVersion.mutateAsync(activateVersionId);
    setActivateVersionId(null);
    onRefresh();
  }

  function selectVersion(versionId: string) {
    if ((isDirty || draft.dirty.semantic || draft.dirty.layout) && !window.confirm("Discard local draft changes?")) {
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

  const hasDraftErrors = draft.validation.issues.some((issue) => issue.severity === "error");

  return (
    <div className="workflow-layout">
      <aside className="panel stack workflow-history">
        <div>
          <h2>Versions</h2>
          <p className="muted">Only the latest version is editable.</p>
        </div>
        <button type="button" className={selectedVersionId === "draft" ? "version-item active" : "version-item"} onClick={() => selectVersion("draft")}>
          <strong>Local draft</strong>
          <span className="muted">{isDirty || draft.dirty.semantic || draft.dirty.layout ? "Unsaved changes" : "Editable draft"}</span>
        </button>
        {workflow.versions.map((version) => (
          <button key={version.id} type="button" className={selectedVersionId === version.id ? "version-item active" : "version-item"} onClick={() => selectVersion(version.id)}>
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
                {(isDirty || draft.dirty.semantic || draft.dirty.layout) && <span className="status-badge">Unsaved draft</span>}
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
          <div className="workflow-actions" role="tablist" aria-label="Workflow editor mode">
            <button type="button" className={mode === "visual" ? "mode-tab active" : "mode-tab"} onClick={() => setMode("visual")}>
              Visual
            </button>
            <button type="button" className={mode === "form" ? "mode-tab active" : "mode-tab"} onClick={() => setMode("form")}>
              Form
            </button>
          </div>
        </section>

        {mode === "visual" ? (
          <WorkflowVisualEditor draft={draft} applyDraft={applyDraft} register={register} errors={errors} setValue={setValue} getValues={getValues} />
        ) : (
          <section className="panel stack">
            <div className="workflow-title-row">
              <div>
                <h2>Steps</h2>
                <p className="muted">Form fallback for accessible detailed editing. Routing fields update the same visual draft.</p>
              </div>
              <div className="workflow-actions">
                <select aria-label="Step type to add" disabled={!isEditable} value={stepTypeToAdd} onChange={(event) => setStepTypeToAdd(event.target.value as StepFormValue["type"])}>
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
                  if (String(name).endsWith(".type")) setTypeNotice("Step type changed. Incompatible configuration fields were removed.");
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
        )}

        <section className="panel workflow-title-row">
          <div>
            <strong>{isValid && !hasDraftErrors ? "Definition valid" : "Definition has errors"}</strong>
            <p className="muted">{isDirty || draft.dirty.semantic || draft.dirty.layout ? "Local draft changes are not saved to the backend." : "No local changes."}</p>
            {draft.validation.issues.map((issue) => (
              <p key={`${issue.code}-${issue.stepKey ?? "global"}-${issue.handle ?? ""}`} className={issue.severity === "error" ? "field-error" : "form-warning"}>
                {issue.stepKey ? `${issue.stepKey}: ${issue.message}` : issue.message}
              </p>
            ))}
          </div>
          <div className="workflow-actions">
            <button type="button" disabled={!isEditable || (!isDirty && !draft.dirty.semantic && !draft.dirty.layout)} onClick={() => applyDraft(initialDraft)}>
              Discard draft
            </button>
            <button type="submit" disabled={!isEditable || !isValid || hasDraftErrors || createVersion.isPending}>
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
