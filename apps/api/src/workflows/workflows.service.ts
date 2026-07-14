import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WorkflowStatus, WorkflowVersionStatus } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowVersionDto } from "./dto/create-workflow-version.dto";

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
                configJson: toPrismaJson(step.config)
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

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
