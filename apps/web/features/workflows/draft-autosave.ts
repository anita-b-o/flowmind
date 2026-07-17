import type { WorkflowDraftModel } from "./draft-model";

const PREFIX = "flowmind.workflowDraft.v1";

export type DraftAutosaveIdentity = {
  userId?: string;
  organizationId?: string;
  workflowId: string;
  versionId?: string;
};

export type DraftAutosaveSnapshot = {
  savedAt: string;
  identity: Required<DraftAutosaveIdentity>;
  draft: WorkflowDraftModel;
};

export function autosaveKey(identity: DraftAutosaveIdentity) {
  return [
    PREFIX,
    identity.userId || "anonymous",
    identity.organizationId || "no-org",
    identity.workflowId,
    identity.versionId || "local-draft"
  ].join(":");
}

export function saveDraftSnapshot(storage: Storage, identity: DraftAutosaveIdentity, draft: WorkflowDraftModel) {
  const snapshot: DraftAutosaveSnapshot = {
    savedAt: new Date().toISOString(),
    identity: completeIdentity(identity),
    draft: sanitizeDraft(draft)
  };
  storage.setItem(autosaveKey(identity), JSON.stringify(snapshot));
  return snapshot;
}

export function loadDraftSnapshot(storage: Storage, identity: DraftAutosaveIdentity): DraftAutosaveSnapshot | null {
  const raw = storage.getItem(autosaveKey(identity));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftAutosaveSnapshot;
    if (!isCompatibleSnapshot(parsed, identity)) return null;
    return parsed;
  } catch {
    storage.removeItem(autosaveKey(identity));
    return null;
  }
}

export function discardDraftSnapshot(storage: Storage, identity: DraftAutosaveIdentity) {
  storage.removeItem(autosaveKey(identity));
}

export function isCompatibleSnapshot(snapshot: DraftAutosaveSnapshot, identity: DraftAutosaveIdentity) {
  const expected = completeIdentity(identity);
  return (
    snapshot?.identity?.userId === expected.userId &&
    snapshot.identity.organizationId === expected.organizationId &&
    snapshot.identity.workflowId === expected.workflowId &&
    snapshot.identity.versionId === expected.versionId &&
    Boolean(snapshot.draft?.workflowMeta && snapshot.savedAt)
  );
}

function completeIdentity(identity: DraftAutosaveIdentity): Required<DraftAutosaveIdentity> {
  return {
    userId: identity.userId || "anonymous",
    organizationId: identity.organizationId || "no-org",
    workflowId: identity.workflowId,
    versionId: identity.versionId || "local-draft"
  };
}

function sanitizeDraft(draft: WorkflowDraftModel): WorkflowDraftModel {
  return {
    ...draft,
    stepsByKey: Object.fromEntries(
      Object.entries(draft.stepsByKey).map(([key, step]) => [
        key,
        {
          ...step,
          config: removeSensitiveKeys(step.config)
        }
      ])
    )
  };
}

function removeSensitiveKeys(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower.includes("secret") || lower.includes("password") || lower.includes("token") || lower.includes("apikey") || lower === "authorization") {
      continue;
    }
    result[key] = entry;
  }
  return result;
}
