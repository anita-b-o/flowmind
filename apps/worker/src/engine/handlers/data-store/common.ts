import { ExecutionContext } from "@automation/shared-types";
import { DataStoreRuntimeContext } from "../../../data-store/data-store-runtime.service";

export function runtimeContext(context: ExecutionContext): DataStoreRuntimeContext {
  const runtime = (context.metadata?.runtime ?? {}) as Record<string, string>;
  const metadata = context.metadata as Record<string, string>;
  const organizationId = runtime.organizationId ?? metadata.organizationId;
  if (!organizationId) throw new Error("Data Store step is missing organization metadata");
  return {
    organizationId,
    executionId: runtime.executionId ?? metadata.executionId,
    stepExecutionId: runtime.stepExecutionId,
    correlationId: runtime.correlationId ?? metadata.correlationId ?? null
  };
}

export function storeSelector(config: Record<string, unknown>) {
  return {
    dataStoreId: typeof config.dataStoreId === "string" ? config.dataStoreId : undefined,
    dataStoreName: typeof config.dataStoreName === "string" ? config.dataStoreName : undefined
  };
}
