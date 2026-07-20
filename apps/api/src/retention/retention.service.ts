import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"] as const;

export type RetentionOptions = {
  organizationId: string;
  payloadCutoff: Date;
  metadataCutoff: Date;
  batchSize: number;
  execute: boolean;
};

export type RetentionReport = {
  mode: "dry_run" | "execute";
  organizationId: string;
  cutoffs: { payload: string; metadata: string };
  candidates: { payloads: number; rootExecutions: number; estimatedJsonBytes: number; oldestPayloadAt: string | null; oldestExecutionAt: string | null };
  changed: { payloads: number; rootExecutions: number };
  batchLimited: boolean;
};

@Injectable()
export class RetentionService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(options: RetentionOptions): Promise<RetentionReport> {
    validate(options);
    const candidateRoots = await this.rootCandidates(options);
    const payloadRows = await this.payloadCandidates(options);
    const report: RetentionReport = {
      mode: options.execute ? "execute" : "dry_run",
      organizationId: options.organizationId,
      cutoffs: { payload: options.payloadCutoff.toISOString(), metadata: options.metadataCutoff.toISOString() },
      candidates: {
        payloads: payloadRows.length,
        rootExecutions: candidateRoots.length,
        estimatedJsonBytes: payloadRows.reduce((total, row) => total + Number(row.bytes), 0),
        oldestPayloadAt: payloadRows.at(-1)?.createdAt.toISOString() ?? null,
        oldestExecutionAt: candidateRoots.at(-1)?.createdAt.toISOString() ?? null
      },
      changed: { payloads: 0, rootExecutions: 0 },
      batchLimited: payloadRows.length === options.batchSize || candidateRoots.length === options.batchSize
    };
    if (!options.execute) return report;

    if (payloadRows.length) {
      const ids = payloadRows.map((row) => row.id);
      const result = await this.prisma.execution.updateMany({
        where: { id: { in: ids }, organizationId: options.organizationId, createdAt: { lt: options.payloadCutoff } },
        data: { inputJson: { retained: false }, contextJson: { retained: false }, outputJson: Prisma.JsonNull, errorJson: Prisma.JsonNull }
      });
      report.changed.payloads = result.count;
      await this.prisma.stepExecution.updateMany({
        where: { organizationId: options.organizationId, executionId: { in: ids } },
        data: { inputJson: { retained: false }, outputJson: Prisma.JsonNull, errorJson: Prisma.JsonNull, debugJson: Prisma.JsonNull }
      });
    }

    for (const root of candidateRoots) {
      await this.deleteTree(options.organizationId, root.id);
      report.changed.rootExecutions += 1;
    }
    return report;
  }

  private payloadCandidates(options: RetentionOptions) {
    return this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; bytes: bigint }>>(Prisma.sql`
      SELECT id, created_at AS "createdAt",
        pg_column_size(input_json) + pg_column_size(context_json) + COALESCE(pg_column_size(output_json), 0) + COALESCE(pg_column_size(error_json), 0) AS bytes
      FROM executions
      WHERE organization_id = ${options.organizationId}
        AND created_at < ${options.payloadCutoff}
        AND input_json <> '{"retained":false}'::jsonb
      ORDER BY created_at ASC, id ASC
      LIMIT ${options.batchSize}
    `);
  }

  private rootCandidates(options: RetentionOptions) {
    return this.prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
      SELECT root.id, root.created_at AS "createdAt"
      FROM executions root
      WHERE root.organization_id = ${options.organizationId}
        AND root.root_execution_id IS NULL
        AND root.parent_execution_id IS NULL
        AND root.status::text IN (${Prisma.join(TERMINAL)})
        AND root.completed_at < ${options.metadataCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM executions related
          WHERE related.organization_id = root.organization_id
            AND (related.root_execution_id = root.id OR related.retry_of_execution_id = root.id OR related.replay_of_execution_id = root.id)
            AND (related.status::text NOT IN (${Prisma.join(TERMINAL)}) OR related.completed_at IS NULL OR related.completed_at >= ${options.metadataCutoff})
        )
      ORDER BY root.created_at ASC, root.id ASC
      LIMIT ${options.batchSize}
    `);
  }

  private async deleteTree(organizationId: string, rootId: string) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.execution.findMany({
        where: { organizationId, OR: [{ id: rootId }, { rootExecutionId: rootId }, { retryOfExecutionId: rootId }, { replayOfExecutionId: rootId }] },
        select: { id: true, depth: true }, orderBy: { depth: "desc" }
      });
      const ids = rows.map((row) => row.id);
      if (!ids.length) return;
      await tx.executionStepReuse.deleteMany({ where: { organizationId, OR: [{ recoveryExecutionId: { in: ids } }, { sourceExecutionId: { in: ids } }] } });
      await tx.execution.updateMany({ where: { organizationId, id: { in: ids } }, data: { retryOfExecutionId: null, replayOfExecutionId: null, parentExecutionId: null, rootExecutionId: null, parentStepExecutionId: null } });
      for (const row of rows) await tx.execution.delete({ where: { id: row.id } });
    });
  }
}

function validate(options: RetentionOptions) {
  if (!options.organizationId.trim()) throw new BadRequestException("organizationId is required");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) throw new BadRequestException("batchSize must be between 1 and 1000");
  if (Number.isNaN(options.payloadCutoff.valueOf()) || Number.isNaN(options.metadataCutoff.valueOf())) throw new BadRequestException("valid cutoffs are required");
  if (options.payloadCutoff >= new Date() || options.metadataCutoff >= new Date()) throw new BadRequestException("cutoffs must be in the past");
}
