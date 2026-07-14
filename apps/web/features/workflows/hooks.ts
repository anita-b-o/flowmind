"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import type { Workflow } from "./types";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: () => apiClient.get<Workflow[]>("/workflows")
  });
}

export function useWorkflow(workflowId: string) {
  const workflows = useWorkflows();
  return {
    ...workflows,
    data: workflows.data?.find((workflow) => workflow.id === workflowId)
  };
}
