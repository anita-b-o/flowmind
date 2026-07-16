"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { ExecutionDetail, ExecutionListResponse, ExecutionStatus } from "./types";

export function useExecutions(params: {
  page: number;
  pageSize: number;
  workflowId?: string;
  status?: ExecutionStatus | "";
}) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["executions", activeOrganizationId, params],
    queryFn: () => apiClient.get<ExecutionListResponse>("/executions", params)
  });
}

export function useExecution(executionId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["execution", activeOrganizationId, executionId],
    queryFn: () => apiClient.get<ExecutionDetail>(`/executions/${executionId}`),
    enabled: Boolean(activeOrganizationId && executionId)
  });
}
