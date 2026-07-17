"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { ScheduledTriggerInput, ScheduledTriggerPreview, ScheduledTriggerSummary, TriggerSecret, TriggerSummary, UpdateWebhookTriggerInput } from "./types";

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

export function useScheduledTriggers(workflowId: string) {
  return useQuery({
    queryKey: ["scheduled-triggers", workflowId],
    queryFn: () => apiClient.get<ScheduledTriggerSummary[]>(`/workflows/${workflowId}/triggers/scheduled`),
    enabled: Boolean(workflowId)
  });
}

export function useCreateScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduledTriggerInput) => apiClient.post<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/scheduled`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function useUpdateScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ triggerId, input }: { triggerId: string; input: ScheduledTriggerInput }) =>
      apiClient.patch<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/scheduled`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function useEnableScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/enable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function useDisableScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/disable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function usePauseScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/pause`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function useResumeScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.patch<ScheduledTriggerSummary>(`/workflows/${workflowId}/triggers/${triggerId}/resume`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function useDeleteScheduledTrigger(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId: string) => apiClient.delete<{ deleted: true }>(`/workflows/${workflowId}/triggers/${triggerId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-triggers", workflowId] });
    }
  });
}

export function usePreviewScheduledTrigger(workflowId: string) {
  return useMutation({
    mutationFn: (input: ScheduledTriggerInput) => apiClient.post<ScheduledTriggerPreview>(`/workflows/${workflowId}/triggers/scheduled/preview`, input)
  });
}
