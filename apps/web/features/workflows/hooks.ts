"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { CreateWorkflowDto, Workflow, WorkflowDefinitionDto, WorkflowDetail } from "./types";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: () => apiClient.get<Workflow[]>("/workflows")
  });
}

export function useWorkflow(workflowId: string) {
  return useQuery({
    queryKey: ["workflows", workflowId],
    queryFn: () => apiClient.get<WorkflowDetail>(`/workflows/${workflowId}`),
    enabled: Boolean(workflowId)
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateWorkflowDto) => apiClient.post<Workflow>("/workflows", dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows"] })
  });
}

export function useCreateWorkflowVersion(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: WorkflowDefinitionDto) => apiClient.post(`/workflows/${workflowId}/versions`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.invalidateQueries({ queryKey: ["workflows", workflowId] });
    }
  });
}

export function useActivateWorkflowVersion(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => apiClient.patch(`/workflows/${workflowId}/versions/${versionId}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.invalidateQueries({ queryKey: ["workflows", workflowId] });
    }
  });
}
