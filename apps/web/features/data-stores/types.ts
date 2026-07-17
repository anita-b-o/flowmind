export interface DataStoreSummary {
  id: string;
  name: string;
  description?: string | null;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DataStoreRecordSummary {
  id: string;
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  version: number;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataStoreRecordListResponse {
  items: DataStoreRecordSummary[];
  page: number;
  pageSize: number;
  total: number;
}
