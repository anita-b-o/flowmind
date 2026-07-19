"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RequireAuth } from "../../../../../features/auth/require-auth";
import { StatusBadge } from "../../../../../components/status-badge";
import { apiClient } from "../../../../../lib/api-client";

export default function StepDetailPage({ params }: { params: Promise<{ executionId: string; stepExecutionId: string }> }) {
  const { executionId, stepExecutionId } = use(params);
  const query = useQuery({ queryKey: ["step-execution", executionId, stepExecutionId], queryFn: () => apiClient.get<any>(`/executions/${executionId}/steps/${stepExecutionId}`) });
  const step = query.data;
  return <RequireAuth><main className="content stack"><p><Link href={`/executions/${executionId}`}>← Execution</Link></p>{query.isLoading && <p>Loading step...</p>}{step && <><section className="panel stack"><h1>{step.stepKey}</h1><StatusBadge status={step.publicStatus ?? step.status} /><p>{step.stepType} · <code>{step.executionPath}</code>{step.iterationIndex !== null ? ` · iteration ${step.iterationIndex}` : ""}</p>{step.reused ? <p>Reused from execution <Link href={`/executions/${step.reusedFromExecutionId}/steps/${step.reusedFromStepExecutionId}`}>{step.reusedFromExecutionId}</Link>. No attempts were created in this replay.</p> : <p>Attempts {step.attemptCount}/{step.maxAttempts} · duration {step.durationMs ?? "-"}ms</p>}<p>Error handled: {step.errorHandled ? "yes" : "no"}</p>{step.retryState && <p>Retry state: {step.retryState}{step.nextRetryAt ? ` until ${new Date(step.nextRetryAt).toLocaleString()}` : ""}</p>}{step.error && <p><strong>{step.error.code}</strong> · {step.error.category} · {step.error.messageSafe}</p>}</section><section className="panel stack"><h2>Attempt history</h2>{step.reused ? <p className="muted">No attempts were created in this replay.</p> : <>{!step.historyComplete && <p className="muted">Some historical attempt detail predates durable attempt tracking.</p>}{step.attempts.map((attempt: any) => <p key={attempt.id}><StatusBadge status={attempt.status} /> Attempt {attempt.attempt}{attempt.waitReason ? ` · ${attempt.waitReason}` : ""}{attempt.durationMs !== null ? ` · ${attempt.durationMs}ms` : ""}{attempt.errorCategory ? ` · ${attempt.errorCategory}` : ""}</p>)}</>}</section></>}</main></RequireAuth>;
}
