export const DEAD_LETTER_REASONS = ["non_retryable", "attempts_exhausted", "ambiguous_effect", "inconsistent_state", "execution_limit", "unknown"] as const;

export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

export const reasonLabels: Record<DeadLetterReason, string> = {
  non_retryable: "Non retryable",
  attempts_exhausted: "Attempts exhausted",
  ambiguous_effect: "Ambiguous effect",
  inconsistent_state: "Inconsistent state",
  execution_limit: "Execution limit",
  unknown: "Unknown"
};

export const reasonDescriptions: Record<DeadLetterReason, string> = {
  non_retryable: "The failure is not expected to succeed by repeating automatically.",
  attempts_exhausted: "The step used all configured attempts.",
  ambiguous_effect: "The external effect may have happened but Flowmind could not confirm it.",
  inconsistent_state: "The execution reached a state that requires manual review.",
  execution_limit: "The execution hit an operational limit.",
  unknown: "Flowmind could not classify the failure."
};
