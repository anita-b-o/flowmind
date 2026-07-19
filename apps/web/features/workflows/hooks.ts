"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type {
  CreateWorkflowDto,
  CreateWorkflowTestRunDto,
  Workflow,
  WorkflowDefinitionDto,
  WorkflowDetail,
  WorkflowTestRunComparison,
  WorkflowTestRunDetail,
  WorkflowTestRunListResponse
  ,InvocableWorkflow, WorkflowVersionHistoryResponse, WorkflowVersionDiff, WorkflowRestorePreview, WorkflowVersion
} from "./types";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: () => apiClient.get<Workflow[]>("/workflows")
  });
}

export function useWorkflowVersions(workflowId: string) {
  return useQuery({ queryKey: ["workflows", workflowId, "versions"], queryFn: () => apiClient.get<WorkflowVersionHistoryResponse>(`/workflows/${workflowId}/versions?limit=100`), enabled: Boolean(workflowId) });
}

export function useWorkflowVersionDiff(workflowId: string, fromId?: string, toId?: string) {
  return useQuery({ queryKey: ["workflows", workflowId, "version-diff", fromId, toId], queryFn: () => apiClient.get<WorkflowVersionDiff>(`/workflows/${workflowId}/versions/${fromId}/diff/${toId}`), enabled: Boolean(workflowId && fromId && toId && fromId !== toId) });
}

export function useWorkflowRestorePreview(workflowId: string, versionId?: string) {
  return useQuery({ queryKey: ["workflows", workflowId, "restore-preview", versionId], queryFn: () => apiClient.get<WorkflowRestorePreview>(`/workflows/${workflowId}/versions/${versionId}/restore-preview`), enabled: Boolean(workflowId && versionId) });
}

export function useRestoreWorkflowVersion(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (versionId: string) => apiClient.post<WorkflowVersion>(`/workflows/${workflowId}/versions/${versionId}/restore`, {}), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["workflows", workflowId] }); queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "versions"] }); } });
}

export function useInvocableWorkflows() {
  return useQuery({ queryKey: ["workflows", "invocable"], queryFn: () => apiClient.get<InvocableWorkflow[]>("/workflows/invocable") });
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

export function useWorkflowTestRuns(workflowId: string) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["workflows", workflowId, "test-runs", activeOrganizationId],
    queryFn: () => apiClient.get<WorkflowTestRunListResponse>(`/workflows/${workflowId}/test-runs`),
    enabled: Boolean(workflowId && activeOrganizationId)
  });
}

export function useWorkflowTestRun(workflowId: string, testRunId?: string | null) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["workflows", workflowId, "test-runs", testRunId, activeOrganizationId],
    queryFn: () => apiClient.get<WorkflowTestRunDetail>(`/workflows/${workflowId}/test-runs/${testRunId}`),
    enabled: Boolean(workflowId && testRunId && activeOrganizationId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "QUEUED" || status === "RUNNING" || status === "RETRYING" ? 1500 : false;
    }
  });
}

export function useCreateWorkflowTestRun(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateWorkflowTestRunDto) => apiClient.post<WorkflowTestRunDetail>(`/workflows/${workflowId}/test-runs`, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "test-runs"] })
  });
}

export function useCancelWorkflowTestRun(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (testRunId: string) => apiClient.post<WorkflowTestRunDetail>(`/workflows/${workflowId}/test-runs/${testRunId}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "test-runs"] })
  });
}

export function useRerunWorkflowTestRun(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (testRunId: string) => apiClient.post<WorkflowTestRunDetail>(`/workflows/${workflowId}/test-runs/${testRunId}/rerun`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "test-runs"] })
  });
}

export function useSkipTestWait(workflowId: string, testRunId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepKey: string) => apiClient.post<WorkflowTestRunDetail>(`/workflows/${workflowId}/test-runs/${testRunId}/steps/${stepKey}/skip-wait`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "test-runs"] })
  });
}

export function useCompareTestRunWithLastReal(workflowId: string, testRunId?: string | null) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["workflows", workflowId, "test-runs", testRunId, "compare-last-real", activeOrganizationId],
    queryFn: () => apiClient.get<WorkflowTestRunComparison>(`/workflows/${workflowId}/test-runs/${testRunId}/compare-last-real`),
    enabled: Boolean(workflowId && testRunId && activeOrganizationId)
  });
}
