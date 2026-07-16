import { Injectable } from "@nestjs/common";
import { ExecutionStatus } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { WorkerIdentityService } from "../runtime/worker-identity.service";
import { LeaseLostError } from "./lease-lost.error";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

const PROCESSABLE_STATUSES = [ExecutionStatus.Pending, ExecutionStatus.Queued, ExecutionStatus.Retrying, ExecutionStatus.Running];

@Injectable()
export class ExecutionLeaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: WorkerIdentityService,
    private readonly metrics?: WorkerMetricsService
  ) {}

  leaseDurationMs() {
    return Number(process.env.EXECUTION_LEASE_DURATION_MS ?? 60_000);
  }

  heartbeatIntervalMs() {
    return Number(process.env.EXECUTION_HEARTBEAT_INTERVAL_MS ?? 15_000);
  }

  async acquire(executionId: string, organizationId: string) {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + this.leaseDurationMs());
    const result = await this.prisma.execution.updateMany({
      where: {
        id: executionId,
        organizationId,
        status: { in: PROCESSABLE_STATUSES },
        OR: [{ lockedBy: null }, { lockedUntil: { lt: now } }, { lockedBy: this.identity.id }]
      },
      data: {
        lockedBy: this.identity.id,
        lockedUntil,
        lastHeartbeatAt: now,
        status: ExecutionStatus.Running,
        runAttempt: { increment: 1 }
      }
    });
    const acquired = result.count === 1;
    this.metrics?.recordLease(acquired ? "acquired" : "conflict");
    return acquired;
  }

  async heartbeat(executionId: string) {
    const now = new Date();
    const result = await this.prisma.execution.updateMany({
      where: { id: executionId, lockedBy: this.identity.id, lockedUntil: { gt: now } },
      data: {
        lockedUntil: new Date(now.getTime() + this.leaseDurationMs()),
        lastHeartbeatAt: now
      }
    });
    if (result.count !== 1) {
      this.metrics?.recordLease("lost");
      throw new LeaseLostError();
    }
  }

  async assertOwned(executionId: string) {
    const now = new Date();
    const count = await this.prisma.execution.count({
      where: { id: executionId, lockedBy: this.identity.id, lockedUntil: { gt: now } }
    });
    if (count !== 1) {
      this.metrics?.recordLease("lost");
      throw new LeaseLostError();
    }
  }

  async release(executionId: string) {
    await this.prisma.execution.updateMany({
      where: { id: executionId, lockedBy: this.identity.id },
      data: { lockedBy: null, lockedUntil: null }
    });
    this.metrics?.recordLease("released");
  }
}
