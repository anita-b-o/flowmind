"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { DataStoreRecordListResponse, DataStoreSummary } from "./types";

export function useDataStores() {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["data-stores", activeOrganizationId],
    queryFn: () => apiClient.get<DataStoreSummary[]>("/data-stores"),
    enabled: Boolean(activeOrganizationId)
  });
}

export function useCreateDataStore() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (dto: { name: string; description?: string }) => apiClient.post<DataStoreSummary>("/data-stores", dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["data-stores", activeOrganizationId] })
  });
}

export function useUpdateDataStore() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: { name?: string; description?: string } }) => apiClient.patch<DataStoreSummary>(`/data-stores/${id}`, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["data-stores", activeOrganizationId] })
  });
}

export function useDeleteDataStore() {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/data-stores/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["data-stores", activeOrganizationId] })
  });
}

export function useDataStoreRecords(dataStoreId?: string, page = 1, q = "") {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["data-stores", activeOrganizationId, dataStoreId, "records", page, q],
    queryFn: () => apiClient.get<DataStoreRecordListResponse>(`/data-stores/${dataStoreId}/records`, { page, pageSize: 20, q }),
    enabled: Boolean(activeOrganizationId && dataStoreId)
  });
}

export function useDeleteDataStoreRecord(dataStoreId?: string) {
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuth();
  return useMutation({
    mutationFn: (key: string) => apiClient.delete(`/data-stores/${dataStoreId}/records/${encodeURIComponent(key)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["data-stores", activeOrganizationId, dataStoreId, "records"] })
  });
}
