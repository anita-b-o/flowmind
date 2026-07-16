export const PUBLIC_DEAD_LETTER_REASONS = [
  "non_retryable",
  "attempts_exhausted",
  "ambiguous_effect",
  "inconsistent_state",
  "execution_limit",
  "unknown"
] as const;

export type PublicDeadLetterReason = (typeof PUBLIC_DEAD_LETTER_REASONS)[number];

export function publicDeadLetterReason(reason: string | null | undefined): PublicDeadLetterReason {
  if (reason === "non_retryable") return "non_retryable";
  if (reason === "attempts_exhausted" || reason === "failed") return "attempts_exhausted";
  if (reason === "ambiguous_effect" || reason === "ambiguous") return "ambiguous_effect";
  if (reason === "inconsistent_state") return "inconsistent_state";
  if (reason === "execution_limit") return "execution_limit";
  return "unknown";
}
