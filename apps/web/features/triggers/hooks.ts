"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { TriggerSecret, TriggerSummary, UpdateWebhookTriggerInput } from "./types";

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
    mutationFn: (input?: UpdateWebhookTriggerInput) => apiClient.post<TriggerSecret>(`/workflows/${workflowId}/triggers`, input ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}

export function useUpdateWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ triggerId, input }: { triggerId: string; input: UpdateWebhookTriggerInput }) => apiClient.patch<TriggerSummary | TriggerSecret>(`/workflows/${workflowId}/triggers/${triggerId}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}

export function useEnableWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<TriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/enable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}

export function useDisableWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<TriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/disable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", workflowId] });
    }
  });
}

export function useDeleteWebhookTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.delete<{ deleted: true }>(`/workflows/${workflowId}/triggers/${triggerId}`),
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
