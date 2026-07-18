import type { SafeStepError } from "@automation/shared-types";

export class StructuredStepFailure extends Error {
  constructor(readonly safeError: SafeStepError, readonly stepExecutionId: string, readonly causeValue?: unknown) {
    super(safeError.message);
    this.name = "StructuredStepFailure";
  }
}
