"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { ExecutionDetail, ExecutionListResponse, ExecutionStatus } from "./types";

export function useExecutions(params: {
  page: number;
  pageSize: number;
  workflowId?: string;
  status?: ExecutionStatus | "";
}) {
  return useQuery({
    queryKey: ["executions", params],
    queryFn: () => apiClient.get<ExecutionListResponse>("/executions", params)
  });
}

export function useExecution(executionId: string) {
  return useQuery({
    queryKey: ["execution", executionId],
    queryFn: () => apiClient.get<ExecutionDetail>(`/executions/${executionId}`),
    enabled: Boolean(executionId)
  });
}
