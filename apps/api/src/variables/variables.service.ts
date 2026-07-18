import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertVariableName, assertVariableValue, WorkflowVariableValidationError } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class VariablesService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrganizationVariables(organizationId: string) {
    return this.prisma.organizationVariable.findMany({ where: { organizationId }, orderBy: { key: "asc" } });
  }

  async listWorkflowVariables(organizationId: string, workflowId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    return this.prisma.workflowVariable.findMany({ where: { organizationId, workflowId }, orderBy: { key: "asc" } });
  }

  async upsertOrganizationVariable(organizationId: string, key: string, value: unknown, description?: string) {
    this.assertVariableKey(key);
    return this.prisma.organizationVariable.upsert({
      where: { organizationId_key: { organizationId, key } },
      update: { valueJson: variableJson(value), description },
      create: { organizationId, key, valueJson: variableJson(value), description }
    });
  }

  async upsertWorkflowVariable(organizationId: string, workflowId: string, key: string, value: unknown, description?: string) {
    this.assertVariableKey(key);
    await this.assertWorkflow(organizationId, workflowId);
    return this.prisma.workflowVariable.upsert({
      where: { workflowId_key: { workflowId, key } },
      update: { valueJson: variableJson(value), description },
      create: { organizationId, workflowId, key, valueJson: variableJson(value), description }
    });
  }

  async deleteOrganizationVariable(organizationId: string, key: string) {
    this.assertVariableKey(key);
    await this.prisma.organizationVariable.deleteMany({ where: { organizationId, key } });
  }

  async deleteWorkflowVariable(organizationId: string, workflowId: string, key: string) {
    this.assertVariableKey(key);
    await this.prisma.workflowVariable.deleteMany({ where: { organizationId, workflowId, key } });
  }

  assertVariableKey(key: string) {
    try {
      assertVariableName(key);
    } catch (error) {
      if (error instanceof WorkflowVariableValidationError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async assertWorkflow(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, select: { id: true } });
    if (!workflow) throw new NotFoundException("Workflow not found");
  }
}

export function variableJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(assertVariableValue(value))) as Prisma.InputJsonValue;
}
