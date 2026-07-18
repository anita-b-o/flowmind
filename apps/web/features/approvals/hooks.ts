"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/api-client";
import { useAuth } from "../auth/use-auth";
import type { Approval, ApprovalList, ApprovalStatus } from "./types";
export function useApprovals(status: ApprovalStatus | "", page: number) { const { activeOrganizationId } = useAuth(); return useQuery({ queryKey: ["approvals", activeOrganizationId, status, page], queryFn: () => apiClient.get<ApprovalList>("/approvals", { status: status || undefined, page, pageSize: 20 }), enabled: Boolean(activeOrganizationId) }); }
export function useApproval(id: string) { const { activeOrganizationId } = useAuth(); return useQuery({ queryKey: ["approval", activeOrganizationId, id], queryFn: () => apiClient.get<Approval>(`/approvals/${id}`), enabled: Boolean(activeOrganizationId && id) }); }
export function useDecideApproval(id: string) { const client = useQueryClient(); return useMutation({ mutationFn: ({ decision, comment }: { decision: "approve" | "reject"; comment?: string }) => apiClient.post<Approval>(`/approvals/${id}/${decision}`, { comment }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["approvals"] }); await client.invalidateQueries({ queryKey: ["approval"] }); } }); }
