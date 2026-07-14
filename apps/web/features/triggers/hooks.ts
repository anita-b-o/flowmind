"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { TriggerSecret, TriggerSummary } from "./types";

export function useTriggers(workflowId: string) {
  return useQuery({
    queryKey: ["triggers", workflowId],
    queryFn: () => apiClient.get<TriggerSummary[]>(`/workflows/${workflowId}/triggers`),
    enabled: Boolean(workflowId)
  });
}

export function useCreateWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<TriggerSecret>(`/workflows/${workflowId}/triggers`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}

export function useRotateWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<TriggerSecret>(`/workflows/${workflowId}/triggers/${triggerId}/rotate`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}
