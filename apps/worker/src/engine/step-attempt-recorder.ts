import { StepExecutionStatus } from "@automation/shared-types";
import type { PrismaService } from "../prisma/prisma.service";

export type StepAttemptSnapshot = {
  organizationId: string;
  executionId: string;
  stepExecutionId: string;
  attempt: number;
  status: StepExecutionStatus;
  startedAt?: Date;
  completedAt?: Date | null;
  durationMs?: number | null;
  nextRetryAt?: Date | null;
  waitReason?: string | null;
  effectStatus?: string | null;
  errorCategory?: string | null;
  errorCodeSafe?: string | null;
  errorMessageSafe?: string | null;
};

export function recordStepAttempt(prisma: Pick<PrismaService, "stepExecutionAttempt">, input: StepAttemptSnapshot) {
  if (!(prisma as any).stepExecutionAttempt) return Promise.resolve(null);
  return prisma.stepExecutionAttempt.upsert({
    where: { stepExecutionId_attempt: { stepExecutionId: input.stepExecutionId, attempt: input.attempt } },
    create: input,
    update: {
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: input.durationMs,
      nextRetryAt: input.nextRetryAt,
      waitReason: input.waitReason,
      effectStatus: input.effectStatus,
      errorCategory: input.errorCategory,
      errorCodeSafe: input.errorCodeSafe,
      errorMessageSafe: input.errorMessageSafe
    }
  });
}
