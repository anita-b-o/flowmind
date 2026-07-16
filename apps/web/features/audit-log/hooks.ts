"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { AuditLogFilters, AuditLogListResponse } from "./types";

export function useAuditLogs(filters: AuditLogFilters, page: number, pageSize = 20) {
  const { activeOrganizationId } = useAuth();
  return useQuery({
    queryKey: ["audit-logs", activeOrganizationId, filters, page],
    queryFn: () => apiClient.get<AuditLogListResponse>("/audit-logs", { ...filters, page, pageSize }),
    enabled: Boolean(activeOrganizationId)
  });
}
