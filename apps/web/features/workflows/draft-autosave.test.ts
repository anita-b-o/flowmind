import { describe, expect, it } from "vitest";
import { autosaveKey, discardDraftSnapshot, loadDraftSnapshot, saveDraftSnapshot } from "./draft-autosave";
import { workflowVersionToDraft } from "./draft-adapters";

describe("workflow draft autosave", () => {
  it("saves, restores, discards, and isolates snapshots", () => {
    const storage = new MemoryStorage();
    const identity = { userId: "user-1", organizationId: "org-1", workflowId: "workflow-1", versionId: "version-1" };
    const draft = workflowVersionToDraft({ name: "Flow", description: "" }, undefined);

    saveDraftSnapshot(storage as Storage, identity, draft);
    expect(loadDraftSnapshot(storage as Storage, identity)?.draft.workflowMeta.name).toBe("Flow");
    expect(loadDraftSnapshot(storage as Storage, { ...identity, workflowId: "workflow-2" })).toBeNull();

    discardDraftSnapshot(storage as Storage, identity);
    expect(loadDraftSnapshot(storage as Storage, identity)).toBeNull();
  });

  it("drops corrupt snapshots and removes sensitive config keys", () => {
    const storage = new MemoryStorage();
    const identity = { userId: "user-1", organizationId: "org-1", workflowId: "workflow-1", versionId: "version-1" };
    storage.setItem(autosaveKey(identity), "{bad");

    expect(loadDraftSnapshot(storage as Storage, identity)).toBeNull();

    const draft = workflowVersionToDraft({ name: "Flow", description: "" }, undefined);
    draft.stepsByKey.secret_step = {
      id: "secret_step",
      key: "secret_step",
      name: "Secret",
      type: "http_request",
      expanded: true,
      config: { authorization: "Bearer secret", url: "/safe" },
      retryPolicy: { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" },
      timeoutSeconds: 30
    };
    draft.stepOrder = ["secret_step"];
    saveDraftSnapshot(storage as Storage, identity, draft);
    expect(loadDraftSnapshot(storage as Storage, identity)?.draft.stepsByKey.secret_step.config.authorization).toBeUndefined();
  });
});

class MemoryStorage {
  private values = new Map<string, string>();
  length = 0;
  clear() {
    this.values.clear();
    this.length = 0;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
    this.length = this.values.size;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
    this.length = this.values.size;
  }
}
