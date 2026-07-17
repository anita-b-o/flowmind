"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/use-auth";
import { apiClient } from "../../lib/api-client";
import type { ConnectionSummary, ConnectionType, CreateConnectionDto, HttpAuthScheme } from "./types";

export function useConnections(filters: { type?: ConnectionType | ""; authScheme?: HttpAuthScheme | ""; status?: string | ""; q?: string } = {}) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["connections", activeOrganizationId, filters],
    queryFn: () => apiClient.get<ConnectionSummary[]>("/connections", normalizeFilters(filters)),
    enabled: Boolean(activeOrganizationId)
  });
}

export function useCreateConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (dto: CreateConnectionDto) => apiClient.post<ConnectionSummary>("/connections", dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useUpdateConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: Record<string, unknown> }) => apiClient.patch<ConnectionSummary>(`/connections/${id}`, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useRotateConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: ({ id, secretValue, secretHeaders }: { id: string; secretValue?: string; secretHeaders?: Record<string, string> }) => apiClient.post<ConnectionSummary>(`/connections/${id}/rotate`, { secretValue, secretHeaders }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useRevokeConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<ConnectionSummary>(`/connections/${id}/revoke`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useEnableConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<ConnectionSummary>(`/connections/${id}/enable`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useDisableConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<ConnectionSummary>(`/connections/${id}/disable`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/connections/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections", activeOrganizationId] })
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: ({ id, url }: { id: string; url?: string }) => apiClient.post<{ success: boolean; durationMs: number; status?: number }>(`/connections/${id}/test`, { url })
  });
}

function normalizeFilters(filters: { type?: ConnectionType | ""; authScheme?: HttpAuthScheme | ""; status?: string | ""; q?: string }) {
  return {
    ...filters,
    type: filters.type === "HTTP_API_KEY" ? "HTTP" : filters.type
  };
}
