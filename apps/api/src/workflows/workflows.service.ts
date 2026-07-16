import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WorkflowStatus, WorkflowVersionStatus } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowVersionDto } from "./dto/create-workflow-version.dto";

const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 5;
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 60_000;
const TIMEOUT_MIN_SECONDS = 1;
const TIMEOUT_MAX_SECONDS = 120;

@Injectable()
export class WorkflowsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.workflow.findMany({
      where: { organizationId },
      include: { activeVersion: true },
      orderBy: { updatedAt: "desc" }
    });
  }

  create(organizationId: string, createdByUserId: string, dto: CreateWorkflowDto) {
    return this.prisma.workflow.create({
      data: {
        organizationId,
        createdByUserId,
        name: dto.name,
        description: dto.description,
        status: WorkflowStatus.Draft
      }
    });
  }

  async createVersion(
    organizationId: string,
    createdByUserId: string,
    workflowId: string,
    dto: CreateWorkflowVersionDto
  ) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) {
      throw new NotFoundException("Workflow not found");
    }

    const latest = await this.prisma.workflowVersion.findFirst({
      where: { workflowId, organizationId },
      orderBy: { versionNumber: "desc" }
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const definition = toPrismaJson({ trigger: dto.trigger, steps: dto.steps });

    return this.prisma.workflowVersion.create({
      data: {
        organizationId,
        workflowId,
        createdByUserId,
        versionNumber,
        definitionJson: definition,
        steps: {
          createMany: {
            data: [
              {
                organizationId,
                key: dto.trigger.key,
                name: dto.trigger.name,
                type: dto.trigger.type,
                position: 0,
                configJson: toPrismaJson(dto.trigger.config)
              },
              ...dto.steps.map((step, index) => ({
                organizationId,
                key: step.key,
                name: step.name,
                type: step.type,
                position: index + 1,
                configJson: toPrismaJson(step.config),
                retryPolicyJson: step.retryPolicy ? toPrismaJson(normalizeRetryPolicy(step.retryPolicy)) : undefined,
                timeoutSeconds: normalizeTimeoutSeconds(step.timeoutSeconds)
              }))
            ]
          }
        }
      },
      include: { steps: true }
    });
  }

  async activateVersion(organizationId: string, workflowId: string, versionId: string) {
    const version = await this.prisma.workflowVersion.findFirst({
      where: { id: versionId, workflowId, organizationId }
    });
    if (!version) {
      throw new NotFoundException("Workflow version not found");
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.updateMany({
        where: { workflowId, organizationId, status: WorkflowVersionStatus.Active },
        data: { status: WorkflowVersionStatus.Archived }
      });
      await tx.workflowVersion.update({
        where: { id: versionId },
        data: { status: WorkflowVersionStatus.Active, activatedAt: new Date() }
      });
      return tx.workflow.update({
        where: { id: workflowId },
        data: {
          status: WorkflowStatus.Active,
          activeVersionId: versionId
        },
        include: { activeVersion: true }
      });
    });
  }
}

function normalizeRetryPolicy(raw: Record<string, unknown>) {
  const retry = isRecord(raw.retry) ? raw.retry : raw;
  return {
    retry: {
      maxAttempts: clampNumber(Number(retry.maxAttempts ?? 1), MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX),
      backoffMs: clampNumber(Number(retry.backoffMs ?? 1000), BACKOFF_MIN_MS, BACKOFF_MAX_MS),
      strategy: retry.strategy === "exponential" ? "exponential" : "fixed"
    }
  };
}

function normalizeTimeoutSeconds(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampNumber(Number(value), TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
