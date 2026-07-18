export type TryRegionStatus = "not_run" | "succeeded" | "failed";

export type TryCatchOutput = {
  status: "succeeded" | "handled" | "failed";
  bodyStatus: TryRegionStatus;
  catchStatus: TryRegionStatus;
  finallyStatus: TryRegionStatus;
  errorHandled: boolean;
  failedStepKey?: string;
  errorCategory?: string;
};

export type SafeStepError = {
  message: string;
  category: string;
  code?: string;
  stepKey: string;
  executionPath: string;
  retryable: boolean;
  attempts: number;
};
