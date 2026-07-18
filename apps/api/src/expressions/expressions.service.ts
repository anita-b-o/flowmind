import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { buildVariableCatalog, ExpressionResolver, validateExpressionsInValue, validateExpressionString, type VariableCatalogEntry } from "@automation/expression-engine";
import { Prisma } from "@prisma/client";
import { sanitizePublic } from "../common/public-sanitizer";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ExpressionsService {
  private readonly resolver = new ExpressionResolver();

  constructor(private readonly prisma: PrismaService) {}

  async catalog(organizationId: string, workflowId: string, versionId?: string): Promise<{ entries: VariableCatalogEntry[] }> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId },
      include: {
        versions: {
          where: versionId ? { id: versionId } : undefined,
          include: { steps: { orderBy: { position: "asc" } } },
          orderBy: { versionNumber: "desc" },
          take: 1
        }
      }
    });
    if (!workflow) throw new NotFoundException("Workflow not found");
    const version = workflow.versions[0];
    const steps = (version?.steps ?? []).filter((step) => step.position > 0).map((step) => ({ key: step.key, name: step.name, type: step.type, config: asRecord(step.configJson) }));
    return { entries: buildVariableCatalog({ steps }) };
  }

  validateValue(value: unknown, availableStepKeys: string[] = [], currentStepKey?: string, localNamespaces?: Array<"item" | "index" | "error">) {
    const result = validateExpressionsInValue(value, { availableStepKeys, currentStepKey, allowMetadata: true, allowConnection: true, localNamespaces });
    if (!result.valid) {
      throw new BadRequestException({ message: "Workflow contains invalid expressions", issues: result.issues });
    }
    return result;
  }

  validateString(expression: string, availableStepKeys: string[] = [], currentStepKey?: string) {
    return validateExpressionString(expression, { availableStepKeys, currentStepKey, allowMetadata: true, allowConnection: true });
  }

  preview(expression: string, sample?: unknown) {
    const validation = this.validateString(expression, ["classify", "extract", "summary", "http", "save"]);
    if (!validation.valid) {
      return { valid: false, issues: validation.issues };
    }
    try {
      const result = this.resolver.resolveString(expression, sampleScope(sample), { mode: "strict" });
      return { valid: true, result: sanitizePublic(result) };
    } catch (error: any) {
      return { valid: false, issues: [typeof error?.toJSON === "function" ? error.toJSON() : { code: "EXPRESSION_PATH_NOT_FOUND", message: error?.message ?? String(error) }] };
    }
  }
}

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sampleScope(sample: unknown) {
  const body = asRecord(sample);
  return {
    trigger: { body, headers: {} },
    workflow: { id: "workflow-preview", versionId: "version-preview", name: "Preview workflow", variables: {} },
    steps: {
      classify: { status: "COMPLETED", output: { category: "high", confidence: 0.98 } },
      extract: { status: "COMPLETED", output: { data: body } },
      summary: { status: "COMPLETED", output: { summary: "Preview summary" } },
      http: { status: "COMPLETED", output: { status: 200, ok: true, body: { ok: true } } },
      save: { status: "COMPLETED", output: { recordId: "record-preview", collection: "preview", createdAt: new Date(0).toISOString() } }
    },
    execution: { id: "execution-preview", correlationId: "correlation-preview", retryOfExecutionId: null, startedAt: new Date(0).toISOString() },
    organization: { id: "organization-preview", slug: "preview", variables: {} },
    connection: { id: "connection-preview", name: "Preview connection", type: "HTTP", authScheme: "API_KEY" },
    metadata: { executionId: "execution-preview" }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
