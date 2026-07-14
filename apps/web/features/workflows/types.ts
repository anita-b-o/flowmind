export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  activeVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
}
