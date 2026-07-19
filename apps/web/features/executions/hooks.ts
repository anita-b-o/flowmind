"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { CancelExecutionResponse, ExecutionDetail, ExecutionListResponse, ExecutionStatus, ExecutionTimelineResponse, ManualExecutionResponse } from "./types";

export function useExecutions(params: {
  cursor?: string;
  limit: number;
  workflowId?: string;
  status?: ExecutionStatus | "";
  from?: string;
  to?: string;
  triggerType?: string;
  relationship?: string;
  waiting?: string;
}) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["executions", activeOrganizationId, params],
    queryFn: () => apiClient.get<ExecutionListResponse>("/executions", params)
  });
}

export function useExecutionTimeline(executionId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({ queryKey: ["execution-timeline", activeOrganizationId, executionId], queryFn: () => apiClient.get<ExecutionTimelineResponse>(`/executions/${executionId}/timeline`, { limit: 100 }), enabled: Boolean(activeOrganizationId && executionId) });
}

export function useExecutionTree(executionId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({ queryKey: ["execution-tree", activeOrganizationId, executionId], queryFn: () => apiClient.get<any>(`/executions/${executionId}/tree`), enabled: Boolean(activeOrganizationId && executionId) });
}

export function useExecution(executionId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["execution", activeOrganizationId, executionId],
    queryFn: () => apiClient.get<ExecutionDetail>(`/executions/${executionId}`),
    enabled: Boolean(activeOrganizationId && executionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "QUEUED" || status === "RUNNING" || status === "RETRYING" || status === "PENDING" ? 2000 : false;
    },
    refetchIntervalInBackground: false
  });
}

export function useCreateManualExecution(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { payload?: { trigger?: Record<string, unknown>; metadata?: Record<string, unknown> }; idempotencyKey: string }) =>
      apiClient.post<ManualExecutionResponse>(`/workflows/${workflowId}/executions`, {
        input: input.payload,
        idempotencyKey: input.idempotencyKey,
        confirmRealEffects: true
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executions"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows", workflowId] });
    }
  });
}

export function useCancelExecution(executionId: string) {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (reason?: string) => apiClient.post<CancelExecutionResponse>(`/executions/${executionId}/cancel`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["execution", activeOrganizationId, executionId] });
      void queryClient.invalidateQueries({ queryKey: ["executions"] });
    }
  });
}
