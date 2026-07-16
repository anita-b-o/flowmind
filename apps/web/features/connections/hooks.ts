"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/use-auth";
import { apiClient } from "../../lib/api-client";
import type { ConnectionSummary, ConnectionType, CreateConnectionDto } from "./types";

export function useConnections(filters: { type?: ConnectionType | ""; status?: string | "" } = {}) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["connections", activeOrganizationId, filters],
    queryFn: () => apiClient.get<ConnectionSummary[]>("/connections"),
    enabled: Boolean(activeOrganizationId),
    select: (items) =>
      items.filter((item) => (!filters.type || item.type === filters.type) && (!filters.status || item.status === filters.status))
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
    mutationFn: ({ id, secretValue }: { id: string; secretValue: string }) => apiClient.post<ConnectionSummary>(`/connections/${id}/rotate`, { secretValue }),
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
