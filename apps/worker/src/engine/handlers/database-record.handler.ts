import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { PrismaService } from "../../prisma/prisma.service";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";

@Injectable()
export class DatabaseRecordHandler implements StepHandler {
  type = StepType.DatabaseRecord;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ExpressionResolver
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      collection: string;
      data: Record<string, unknown>;
    };
    assertConfig(config);
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, string>;
    const metadata = context.metadata as Record<string, string>;
    const organizationId = runtime.organizationId ?? metadata.organizationId;
    const workflowId = metadata.workflowId;
    const workflowVersionId = metadata.workflowVersionId;
    const executionId = runtime.executionId ?? metadata.executionId;
    const stepExecutionId = runtime.stepExecutionId;
    if (!organizationId || !workflowId || !executionId || !stepExecutionId) {
      throw new Error("Database record step is missing execution metadata");
    }
    const record = await this.prisma.internalRecord.create({
      data: {
        organizationId,
        workflowId,
        workflowVersionId,
        executionId,
        stepExecutionId,
        collection: config.collection,
        dataJson: toJson(config.data)
      }
    });

    return {
      status: StepExecutionStatus.Completed,
      output: {
        recordId: record.id,
        collection: record.collection,
        createdAt: record.createdAt
      }
    };
  }
}

function assertConfig(config: { collection?: unknown; data?: unknown }) {
  if (typeof config.collection !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.collection)) {
    throw new Error("database_record.collection must be 1-64 chars using letters, numbers, _ or -");
  }
  if (!config.data || typeof config.data !== "object" || Array.isArray(config.data)) {
    throw new Error("database_record.data must be a JSON object");
  }
  if (JSON.stringify(config.data).length > 32_000) {
    throw new Error("database_record.data is too large");
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
