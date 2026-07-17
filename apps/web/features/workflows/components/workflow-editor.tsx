"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../auth/use-auth";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorMessage } from "../../../components/error-message";
import { StatusBadge } from "../../../components/status-badge";
import { draftToFormValue, draftToWorkflowDefinitionDto, formValueToDraft, workflowVersionToDraft } from "../draft-adapters";
import type { WorkflowDraftModel } from "../draft-model";
import { createDraftHistory, pushDraftHistory, redoDraftHistory, resetDraftHistory, undoDraftHistory } from "../draft-history";
import { discardDraftSnapshot, loadDraftSnapshot, saveDraftSnapshot, type DraftAutosaveSnapshot } from "../draft-autosave";
import { useActivateWorkflowVersion, useCreateWorkflowVersion } from "../hooks";
import type { WorkflowDetail, WorkflowVersion } from "../types";
import { emptyStep, STEP_TYPES, workflowEditorSchema, type StepFormValue, type WorkflowEditorFormValue } from "../workflow-builder";
import { StepCard } from "./step-card";
import { WorkflowVisualEditor } from "./visual/workflow-visual-editor";
import { WorkflowDebugger } from "../debugger/workflow-debugger";

type EditorMode = "visual" | "form" | "debugger";
type SaveState = "clean" | "dirty" | "saving" | "saved" | "save_error" | "recovered" | "stale_or_conflict";
type DebuggerSource = "version" | "draft";

export function WorkflowEditor({ workflow, onRefresh }: { workflow: WorkflowDetail; onRefresh: () => void }) {
  const router = useRouter();
  const auth = useAuth();
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
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [recoverySnapshot, setRecoverySnapshot] = useState<DraftAutosaveSnapshot | null>(null);
  const [debuggerConfirmOpen, setDebuggerConfirmOpen] = useState(false);
  const [debuggerSource, setDebuggerSource] = useState<DebuggerSource>("version");
  const selectedVersion = workflow.versions.find((version) => version.id === selectedVersionId);
  const versionForForm = selectedVersion ?? latestVersion;
  const isLatest = Boolean(selectedVersion && latestVersion && selectedVersion.id === latestVersion.id);
  const isEditable = !selectedVersion || isLatest;
  const createVersion = useCreateWorkflowVersion(workflow.id);
  const activateVersion = useActivateWorkflowVersion(workflow.id);
  const initialDraft = useMemo(() => workflowVersionToDraft(workflow, versionForForm, !isEditable), [workflow, versionForForm, isEditable]);
  const [history, setHistory] = useState(() => createDraftHistory(initialDraft));
  const draft = history.present;
  const syncingRef = useRef(false);
  const dirtyRef = useRef(false);
  const autosaveIdentity = useMemo(
    () => ({
      userId: auth.user?.id,
      organizationId: auth.activeOrganizationId,
      workflowId: workflow.id,
      versionId: selectedVersion?.id ?? latestVersion?.id ?? "local-draft"
    }),
    [auth.activeOrganizationId, auth.user?.id, latestVersion?.id, selectedVersion?.id, workflow.id]
  );

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
    setHistory((current) => resetDraftHistory(current, initialDraft));
    setSaveState("clean");
    syncingRef.current = true;
    reset(draftToFormValue(initialDraft));
    queueMicrotask(() => {
      syncingRef.current = false;
    });
  }, [initialDraft, reset]);

  useEffect(() => {
    const subscription = watch((value) => {
      if (syncingRef.current || draft.readOnly || !value.name || !Array.isArray(value.steps)) return;
      applyDraft(formValueToDraft(value as WorkflowEditorFormValue, draft));
    });
    return () => subscription.unsubscribe();
  }, [watch, draft]);

  useEffect(() => {
    dirtyRef.current = hasUnsavedChanges();
  });

  useEffect(() => {
    if (typeof window === "undefined" || draft.readOnly) return;
    const snapshot = loadDraftSnapshot(window.localStorage, autosaveIdentity);
    if (snapshot && snapshot.savedAt > (versionForForm?.createdAt ?? "")) {
      setRecoverySnapshot(snapshot);
    }
  }, [autosaveIdentity, draft.readOnly, versionForForm?.createdAt]);

  useEffect(() => {
    if (typeof window === "undefined" || draft.readOnly || !hasUnsavedChanges()) return;
    const handle = window.setTimeout(() => {
      saveDraftSnapshot(window.localStorage, autosaveIdentity, draft);
    }, 800);
    return () => window.clearTimeout(handle);
  }, [autosaveIdentity, draft]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier || draft.readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [draft.readOnly, history]);

  function applyDraft(next: WorkflowDraftModel, options: { syncForm?: boolean; record?: boolean } = {}) {
    setHistory((current) => pushDraftHistory(current, next, { record: options.record }));
    if (saveState !== "recovered") setSaveState("dirty");
    if (options.syncForm !== false) {
      syncingRef.current = true;
      reset(draftToFormValue(next), { keepDirty: true, keepErrors: true });
      queueMicrotask(() => {
        syncingRef.current = false;
      });
    }
  }

  async function submit(values: WorkflowEditorFormValue) {
    if (createVersion.isPending) return undefined;
    const nextDraft = formValueToDraft(values, draft);
    applyDraft(nextDraft, { syncForm: false });
    if (nextDraft.validation.issues.some((issue) => issue.severity === "error")) {
      setSaveState("save_error");
      return;
    }
    try {
      setSaveState("saving");
      const version = (await createVersion.mutateAsync(draftToWorkflowDefinitionDto(nextDraft))) as WorkflowVersion;
      setSaveState("saved");
      if (typeof window !== "undefined") discardDraftSnapshot(window.localStorage, autosaveIdentity);
      setSelectedVersionId(version.id);
      router.replace(`${pathname}?version=${version.id}`);
      onRefresh();
      return version;
    } catch (error) {
      setSaveState("save_error");
      return undefined;
    }
  }

  async function confirmActivation() {
    if (!activateVersionId) return;
    await activateVersion.mutateAsync(activateVersionId);
    setActivateVersionId(null);
    onRefresh();
  }

  function selectVersion(versionId: string) {
    if (hasUnsavedChanges() && !window.confirm("Discard local draft changes?")) {
      return;
    }
    setSelectedVersionId(versionId);
    router.replace(versionId === "draft" ? pathname : `${pathname}?version=${versionId}`);
  }

  function undo() {
    const next = undoDraftHistory(history);
    setHistory(next);
    syncFormFromDraft(next.present);
    setSaveState("dirty");
  }

  function redo() {
    const next = redoDraftHistory(history);
    setHistory(next);
    syncFormFromDraft(next.present);
    setSaveState("dirty");
  }

  function syncFormFromDraft(next: WorkflowDraftModel) {
    syncingRef.current = true;
    reset(draftToFormValue(next), { keepDirty: true, keepErrors: true });
    queueMicrotask(() => {
      syncingRef.current = false;
    });
  }

  function hasUnsavedChanges() {
    return isDirty || draft.dirty.semantic || draft.dirty.layout || saveState === "recovered";
  }

  function restoreSnapshot(snapshot: DraftAutosaveSnapshot) {
    applyDraft({ ...snapshot.draft, readOnly: false }, { syncForm: true });
    setSaveState("recovered");
    setRecoverySnapshot(null);
  }

  function discardSnapshot() {
    if (typeof window !== "undefined") discardDraftSnapshot(window.localStorage, autosaveIdentity);
    setRecoverySnapshot(null);
  }

  function discardDraft() {
    setHistory((current) => resetDraftHistory(current, initialDraft));
    syncFormFromDraft(initialDraft);
    setSaveState("clean");
    if (typeof window !== "undefined") discardDraftSnapshot(window.localStorage, autosaveIdentity);
  }

  async function openDebuggerFromChoice(source: DebuggerSource) {
    if (source === "version") {
      setDebuggerSource("version");
      setMode("debugger");
      setDebuggerConfirmOpen(false);
      return;
    }
    setDebuggerSource("draft");
    setMode("debugger");
    setDebuggerConfirmOpen(false);
  }

  async function saveAndOpenDebugger() {
    const version = await submit(getValues());
    if (!version) return;
    setDebuggerSource("version");
    setMode("debugger");
    setDebuggerConfirmOpen(false);
  }

  function requestMode(nextMode: EditorMode) {
    if (nextMode !== "debugger") {
      setMode(nextMode);
      return;
    }
    if (hasUnsavedChanges()) {
      setDebuggerConfirmOpen(true);
      return;
    }
    setDebuggerSource("version");
    setMode("debugger");
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
  const saveLabel = saveStateLabel(saveState, createVersion.isPending);

  return (
    <div className="workflow-layout">
      <aside className="panel stack workflow-history">
        <div>
          <h2>Versions</h2>
          <p className="muted">Only the latest version is editable.</p>
        </div>
        <button type="button" className={selectedVersionId === "draft" ? "version-item active" : "version-item"} onClick={() => selectVersion("draft")}>
          <strong>Local draft</strong>
          <span className="muted">{hasUnsavedChanges() ? "Unsaved changes" : "Editable draft"}</span>
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
                <span className="status-badge" aria-live="polite">{saveLabel}</span>
                {hasUnsavedChanges() && <span className="status-badge">Unsaved draft</span>}
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
            <button type="button" className={mode === "visual" ? "mode-tab active" : "mode-tab"} onClick={() => requestMode("visual")}>
              Visual
            </button>
            <button type="button" className={mode === "form" ? "mode-tab active" : "mode-tab"} onClick={() => requestMode("form")}>
              Form
            </button>
            <button type="button" className={mode === "debugger" ? "mode-tab active" : "mode-tab"} onClick={() => requestMode("debugger")}>
              Debugger
            </button>
          </div>
        </section>

        {mode === "visual" ? (
          <WorkflowVisualEditor
            draft={draft}
            applyDraft={applyDraft}
            canUndo={Boolean(history.past.length)}
            canRedo={Boolean(history.future.length)}
            onUndo={undo}
            onRedo={redo}
            saveState={saveLabel}
            saving={createVersion.isPending}
            register={register}
            errors={errors}
            setValue={setValue}
            getValues={getValues}
          />
        ) : mode === "debugger" ? (
          <WorkflowDebugger workflow={workflow} draft={draft} workflowVersionId={selectedVersion?.id ?? latestVersion?.id} source={debuggerSource} />
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
            <p className="muted">{hasUnsavedChanges() ? "Local draft changes are not saved to the backend." : "No local changes."}</p>
            {draft.validation.issues.map((issue, index) => (
              <p key={`${issue.code}-${issue.stepKey ?? "global"}-${issue.edgeId ?? ""}-${issue.handle ?? ""}-${index}`} className={issue.severity === "error" ? "field-error" : "form-warning"}>
                {issue.stepKey ? `${issue.stepKey}: ${issue.message}` : issue.message}
              </p>
            ))}
          </div>
          <div className="workflow-actions">
            <button type="button" disabled={!isEditable || !hasUnsavedChanges() || createVersion.isPending} onClick={discardDraft}>
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
      <RecoveryDialog snapshot={recoverySnapshot} onRestore={restoreSnapshot} onDiscard={discardSnapshot} />
      <DebuggerChoiceDialog
        open={debuggerConfirmOpen}
        hasDraftErrors={hasDraftErrors}
        pending={createVersion.isPending}
        onCancel={() => setDebuggerConfirmOpen(false)}
        onSaveAndTest={() => void saveAndOpenDebugger()}
        onDraftSnapshot={() => void openDebuggerFromChoice("draft")}
      />
    </div>
  );
}

function saveStateLabel(state: SaveState, pending: boolean) {
  if (pending || state === "saving") return "Saving";
  if (state === "dirty") return "Unsaved changes";
  if (state === "saved") return "Saved";
  if (state === "save_error") return "Save error";
  if (state === "recovered") return "Recovered local changes";
  if (state === "stale_or_conflict") return "Version changed";
  return "No changes";
}

function RecoveryDialog({ snapshot, onRestore, onDiscard }: { snapshot: DraftAutosaveSnapshot | null; onRestore: (snapshot: DraftAutosaveSnapshot) => void; onDiscard: () => void }) {
  if (!snapshot) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Recover local workflow draft">
        <h2>Recover local draft</h2>
        <p className="muted">A local draft from {formatDate(snapshot.savedAt)} is newer than this version. It was not saved to the backend.</p>
        <div className="workflow-actions">
          <button type="button" onClick={onDiscard}>Discard local copy</button>
          <button type="button" onClick={() => onRestore(snapshot)}>Restore local copy</button>
        </div>
      </section>
    </div>
  );
}

function DebuggerChoiceDialog({
  open,
  hasDraftErrors,
  pending,
  onCancel,
  onSaveAndTest,
  onDraftSnapshot
}: {
  open: boolean;
  hasDraftErrors: boolean;
  pending: boolean;
  onCancel: () => void;
  onSaveAndTest: () => void;
  onDraftSnapshot: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Choose workflow test source">
        <h2>Choose test source</h2>
        <p className="muted">This workflow has local changes. Choose whether the debugger should run a saved version or an explicit draft snapshot.</p>
        {hasDraftErrors && <p className="field-error" aria-live="assertive">Fix graph errors before testing a draft snapshot or creating a new version.</p>}
        <div className="workflow-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" disabled={pending || hasDraftErrors} onClick={onSaveAndTest}>{pending ? "Saving..." : "Save and test"}</button>
          <button type="button" disabled={hasDraftErrors} onClick={onDraftSnapshot}>Test draft snapshot</button>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
