export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  actor: { id: string; display: string } | null;
  correlationId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AuditLogListResponse {
  items: AuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AuditLogFilters {
  action?: string;
  resourceType?: string;
  from?: string;
  to?: string;
}
