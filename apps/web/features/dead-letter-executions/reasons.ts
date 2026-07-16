export const DEAD_LETTER_REASONS = [
  "non_retryable",
  "attempts_exhausted",
  "ambiguous_effect",
  "inconsistent_state",
  "invalid_wait",
  "branch_resolution_failed",
  "control_validation_failed",
  "execution_limit",
  "unknown"
] as const;

export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

export const reasonLabels: Record<DeadLetterReason, string> = {
  non_retryable: "Non retryable",
  attempts_exhausted: "Attempts exhausted",
  ambiguous_effect: "Ambiguous effect",
  inconsistent_state: "Inconsistent state",
  invalid_wait: "Invalid wait",
  branch_resolution_failed: "Branch resolution failed",
  control_validation_failed: "Control validation failed",
  execution_limit: "Execution limit",
  unknown: "Unknown"
};

export const reasonDescriptions: Record<DeadLetterReason, string> = {
  non_retryable: "The failure is not expected to succeed by repeating automatically.",
  attempts_exhausted: "The step used all configured attempts.",
  ambiguous_effect: "The external effect may have happened but Flowmind could not confirm it.",
  inconsistent_state: "The execution reached a state that requires manual review.",
  invalid_wait: "A Delay or Wait Until step resolved to an invalid wait.",
  branch_resolution_failed: "An If or Switch step could not resolve a valid branch.",
  control_validation_failed: "The workflow graph failed a runtime validation check.",
  execution_limit: "The execution hit an operational limit.",
  unknown: "Flowmind could not classify the failure."
};
