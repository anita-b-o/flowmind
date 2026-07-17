import type { WorkflowDraftModel } from "./draft-model";

export type DraftHistory = {
  past: WorkflowDraftModel[];
  present: WorkflowDraftModel;
  future: WorkflowDraftModel[];
  limit: number;
};

export function createDraftHistory(present: WorkflowDraftModel, limit = 50): DraftHistory {
  return { past: [], present, future: [], limit };
}

export function resetDraftHistory(history: DraftHistory, present: WorkflowDraftModel): DraftHistory {
  return { past: [], present, future: [], limit: history.limit };
}

export function pushDraftHistory(history: DraftHistory, next: WorkflowDraftModel, options: { record?: boolean } = {}): DraftHistory {
  if (options.record === false || next === history.present) {
    return { ...history, present: next };
  }
  const past = [...history.past, history.present].slice(-history.limit);
  return { ...history, past, present: next, future: [] };
}

export function undoDraftHistory(history: DraftHistory): DraftHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, history.limit)
  };
}

export function redoDraftHistory(history: DraftHistory): DraftHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present: next,
    future: history.future.slice(1)
  };
}
