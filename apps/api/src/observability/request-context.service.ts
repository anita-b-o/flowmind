import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import { newTraceId, type TraceContext } from "@automation/observability";

export type ApiRequestContext = TraceContext & {
  userId?: string;
  organizationId?: string;
  workflowId?: string;
  executionId?: string;
};

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<ApiRequestContext>();

  run<T>(context: ApiRequestContext, callback: () => T) {
    return this.storage.run(context, callback);
  }

  getContext() {
    return this.storage.getStore();
  }

  getRequestId() {
    return this.storage.getStore()?.requestId ?? newTraceId();
  }

  getCorrelationId() {
    return this.storage.getStore()?.correlationId ?? newTraceId();
  }

  setCorrelationId(correlationId: string) {
    const context = this.storage.getStore();
    if (context) {
      context.correlationId = correlationId;
    }
  }

  patchContext(patch: Partial<ApiRequestContext>) {
    const context = this.storage.getStore();
    if (context) {
      Object.assign(context, patch);
    }
  }
}
