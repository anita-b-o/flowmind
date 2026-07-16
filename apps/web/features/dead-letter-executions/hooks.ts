"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { DeadLetterDetail, DeadLetterListResponse, DeadLetterStatusFilter, RetryExecutionResponse } from "./types";

export type DeadLetterFilters = {
  status?: DeadLetterStatusFilter;
  workflowId?: string;
  reason?: string;
  from?: string;
  to?: string;
};

export function deadLetterListKey(activeOrganizationId: string | undefined, filters: DeadLetterFilters, page: number) {
  return ["dead-letter-executions", activeOrganizationId, filters, page] as const;
}

export function deadLetterDetailKey(activeOrganizationId: string | undefined, deadLetterId: string) {
  return ["dead-letter-execution", activeOrganizationId, deadLetterId] as const;
}

export function useDeadLetterExecutions(filters: DeadLetterFilters, page: number, pageSize = 20) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: deadLetterListKey(activeOrganizationId, filters, page),
    queryFn: () => apiClient.get<DeadLetterListResponse>("/dead-letter-executions", { ...filters, page, pageSize }),
    enabled: Boolean(activeOrganizationId)
  });
}

export function useDeadLetterExecution(deadLetterId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: deadLetterDetailKey(activeOrganizationId, deadLetterId),
    queryFn: () => apiClient.get<DeadLetterDetail>(`/dead-letter-executions/${deadLetterId}`),
    enabled: Boolean(activeOrganizationId && deadLetterId)
  });
}

export function useRetryExecution(originalExecutionId: string, deadLetterId?: string) {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (reason?: string) => apiClient.post<RetryExecutionResponse>(`/executions/${originalExecutionId}/retry`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dead-letter-executions"] });
      if (deadLetterId) void queryClient.invalidateQueries({ queryKey: deadLetterDetailKey(activeOrganizationId, deadLetterId) });
      void queryClient.invalidateQueries({ queryKey: ["executions"] });
      void queryClient.invalidateQueries({ queryKey: ["execution", activeOrganizationId, originalExecutionId] });
      void queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
    }
  });
}
