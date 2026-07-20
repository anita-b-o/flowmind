import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, WorkflowStatus, WorkflowTemplateStatus, WorkflowVersionStatus } from "@prisma/client";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { WorkflowsService } from "../workflows/workflows.service";
import { CloneWorkflowDto, CreateTemplateFromWorkflowVersionDto, CreateTemplateVersionDto, InstantiateTemplateDto, ListTemplateVersionsQueryDto, ListWorkflowTemplatesQueryDto, PreviewTemplateDto } from "./dto/workflow-template.dto";
import { applyMappings, extractDependencies, normalizePortableDefinition, safeTriggerHints, type DependencyManifest, type Mapping, type TemplateDependency } from "./workflow-template-pipeline";

@Injectable()
export class WorkflowTemplatesService {
  constructor(private readonly prisma: PrismaService, private readonly workflows: WorkflowsService, private readonly audit: AuditLogsService, private readonly metrics: ApiMetricsService) {}

  async list(organizationId: string, query: ListWorkflowTemplatesQueryDto) {
    const limit = Math.min(query.limit ?? 20, 100);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.workflowTemplate.findMany({
      where: { organizationId, ...(query.status ? { status: query.status as WorkflowTemplateStatus } : {}), ...(cursor ? { OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: limit + 1,
      include: { _count: { select: { versions: true } }, versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { id: true, versionNumber: true, publishedAt: true } } }
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items: items.map(publicTemplate), pageSize: limit, hasMore, nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null };
  }

  async detail(organizationId: string, templateId: string) {
    const row = await this.prisma.workflowTemplate.findFirst({ where: { id: templateId, organizationId }, include: { createdBy: { select: { id: true, name: true, email: true } }, _count: { select: { versions: true } } } });
    if (!row) throw new NotFoundException("Workflow template not found");
    return publicTemplate(row);
  }

  async versions(organizationId: string, templateId: string, query: ListTemplateVersionsQueryDto) {
    await this.assertTemplate(organizationId, templateId);
    const limit = Math.min(query.limit ?? 20, 100); const cursor = decodeVersionCursor(query.cursor);
    const rows = await this.prisma.workflowTemplateVersion.findMany({ where: { templateId, template: { organizationId }, ...(cursor ? { OR: [{ versionNumber: { lt: cursor.versionNumber } }, { versionNumber: cursor.versionNumber, id: { lt: cursor.id } }] } : {}) }, orderBy: [{ versionNumber: "desc" }, { id: "desc" }], take: limit + 1, select: versionSelect });
    const hasMore = rows.length > limit; const items = rows.slice(0, limit);
    return { items: items.map(publicTemplateVersion), pageSize: limit, hasMore, nextCursor: hasMore ? encodeVersionCursor(items.at(-1)!) : null };
  }

  async versionDetail(organizationId: string, templateId: string, versionId: string) {
    const row = await this.loadTemplateVersion(organizationId, templateId, versionId);
    return publicTemplateVersion(row);
  }

  async createFromWorkflowVersion(organizationId: string, userId: string, dto: CreateTemplateFromWorkflowVersionDto) {
    try {
      const snapshot = await this.sourceSnapshot(organizationId, dto.workflowId, dto.workflowVersionId);
      const created = await this.prisma.$transaction(async (tx) => {
        const template = await tx.workflowTemplate.create({ data: { organizationId, createdByUserId: userId, name: dto.name.trim(), description: dto.description?.trim() || null } });
        const version = await tx.workflowTemplateVersion.create({ data: { templateId: template.id, versionNumber: 1, definitionJson: json(snapshot.definition), dependencyManifestJson: json(snapshot.manifest), sourceWorkflowId: dto.workflowId, sourceWorkflowVersionId: dto.workflowVersionId } });
        await this.audit.record({ organizationId, actorUserId: userId, action: "template.created", resourceType: "WorkflowTemplate", resourceId: template.id, metadata: { templateVersionId: version.id, versionNumber: 1, dependencyCount: snapshot.manifest.dependencies.length } }, tx);
        return { ...template, versions: [version] };
      });
      this.metrics.recordWorkflowTemplateCreated("success");
      return { ...publicTemplate(created), versions: created.versions.map(publicTemplateVersion) };
    } catch (error) { this.metrics.recordWorkflowTemplateCreated("failed"); throw error; }
  }

  async createVersion(organizationId: string, userId: string, templateId: string, dto: CreateTemplateVersionDto) {
    const snapshot = await this.sourceSnapshot(organizationId, dto.workflowId, dto.workflowVersionId);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: WorkflowTemplateStatus }>>(Prisma.sql`SELECT "status" FROM "workflow_templates" WHERE "id" = ${templateId} AND "organization_id" = ${organizationId} FOR UPDATE`);
      if (!locked.length) throw new NotFoundException("Workflow template not found");
      if (locked[0].status === WorkflowTemplateStatus.ARCHIVED) throw new ConflictException("Archived templates are immutable");
      const latest = await tx.workflowTemplateVersion.findFirst({ where: { templateId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } });
      const version = await tx.workflowTemplateVersion.create({ data: { templateId, versionNumber: (latest?.versionNumber ?? 0) + 1, definitionJson: json(snapshot.definition), dependencyManifestJson: json(snapshot.manifest), sourceWorkflowId: dto.workflowId, sourceWorkflowVersionId: dto.workflowVersionId } });
      await tx.workflowTemplate.update({ where: { id: templateId }, data: { updatedAt: new Date() } });
      await this.audit.record({ organizationId, actorUserId: userId, action: "template.version_created", resourceType: "WorkflowTemplateVersion", resourceId: version.id, metadata: { templateId, versionNumber: version.versionNumber, dependencyCount: snapshot.manifest.dependencies.length } }, tx);
      return publicTemplateVersion(version);
    });
  }

  async publish(organizationId: string, userId: string, templateId: string, versionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: WorkflowTemplateStatus }>>(Prisma.sql`SELECT "status" FROM "workflow_templates" WHERE "id" = ${templateId} AND "organization_id" = ${organizationId} FOR UPDATE`);
      if (!locked.length) throw new NotFoundException("Workflow template not found");
      if (locked[0].status === WorkflowTemplateStatus.ARCHIVED) throw new ConflictException("Archived templates are immutable");
      const updated = await tx.workflowTemplateVersion.updateMany({ where: { id: versionId, templateId, publishedAt: null }, data: { publishedAt: new Date() } });
      if (updated.count !== 1) throw new ConflictException("Template version is already published or unavailable");
      const template = await tx.workflowTemplate.update({ where: { id: templateId }, data: { status: WorkflowTemplateStatus.PUBLISHED } });
      await this.audit.record({ organizationId, actorUserId: userId, action: "template.published", resourceType: "WorkflowTemplateVersion", resourceId: versionId, metadata: { templateId } }, tx);
      return publicTemplate(template);
    });
  }

  async archive(organizationId: string, userId: string, templateId: string) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.workflowTemplate.findFirst({ where: { id: templateId, organizationId } });
      if (!found) throw new NotFoundException("Workflow template not found");
      if (found.status === WorkflowTemplateStatus.ARCHIVED) throw new ConflictException("Template is already archived");
      const row = await tx.workflowTemplate.update({ where: { id: templateId }, data: { status: WorkflowTemplateStatus.ARCHIVED } });
      await this.audit.record({ organizationId, actorUserId: userId, action: "template.archived", resourceType: "WorkflowTemplate", resourceId: templateId }, tx);
      return publicTemplate(row);
    });
  }

  async preview(organizationId: string, templateId: string, versionId: string, dto: PreviewTemplateDto) {
    const source = await this.loadTemplateVersion(organizationId, templateId, versionId);
    return this.buildPreview(organizationId, source.definitionJson as Record<string, unknown>, source.dependencyManifestJson as unknown as DependencyManifest, dto.mappings, source.template.status !== WorkflowTemplateStatus.PUBLISHED || !source.publishedAt ? ["Template version must be published before instantiation"] : []);
  }

  async instantiate(organizationId: string, userId: string, templateId: string, versionId: string, dto: InstantiateTemplateDto) {
    try {
      const source = await this.loadTemplateVersion(organizationId, templateId, versionId);
      if (source.template.status !== WorkflowTemplateStatus.PUBLISHED || !source.publishedAt) throw new ConflictException("Only published template versions can be instantiated");
      const preview = await this.buildPreview(organizationId, source.definitionJson as Record<string, unknown>, source.dependencyManifestJson as unknown as DependencyManifest, dto.mappings);
      if (!preview.canInstantiate) { this.metrics.recordWorkflowMappingFailure(preview.blockers[0]?.code ?? "unresolved"); throw new BadRequestException("Template dependencies are not fully resolved"); }
      const workflow = await this.materialize(organizationId, userId, dto.name, dto.description, preview.definition, { action: "template.instantiated", templateId, templateVersionId: versionId }, { templateId, versionId });
      this.metrics.recordWorkflowInstantiation("success");
      return workflow;
    } catch (error) { this.metrics.recordWorkflowInstantiation("failed"); throw error; }
  }

  async clonePreview(organizationId: string, workflowId: string, dto: CloneWorkflowDto) {
    const snapshot = await this.sourceSnapshot(organizationId, workflowId, dto.sourceWorkflowVersionId);
    return this.buildPreview(organizationId, snapshot.definition, snapshot.manifest, mergeAutoMappings(snapshot.manifest.dependencies, dto.mappings));
  }

  async clone(organizationId: string, userId: string, workflowId: string, dto: CloneWorkflowDto) {
    try {
      const snapshot = await this.sourceSnapshot(organizationId, workflowId, dto.sourceWorkflowVersionId);
      const preview = await this.buildPreview(organizationId, snapshot.definition, snapshot.manifest, mergeAutoMappings(snapshot.manifest.dependencies, dto.mappings));
      if (!preview.canInstantiate) { this.metrics.recordWorkflowMappingFailure(preview.blockers[0]?.code ?? "unresolved"); throw new BadRequestException("Workflow dependencies are not fully resolved"); }
      const workflow = await this.materialize(organizationId, userId, dto.name, dto.description, preview.definition, { action: "workflow.cloned", sourceWorkflowId: workflowId, sourceWorkflowVersionId: dto.sourceWorkflowVersionId });
      this.metrics.recordWorkflowClone("success");
      return workflow;
    } catch (error) { this.metrics.recordWorkflowClone("failed"); throw error; }
  }

  private async sourceSnapshot(organizationId: string, workflowId: string, workflowVersionId: string) {
    const source = await this.prisma.workflowVersion.findFirst({ where: { id: workflowVersionId, workflowId, organizationId }, include: { steps: { orderBy: { position: "asc" } } } });
    if (!source) throw new NotFoundException("Workflow version not found");
    assertSnapshotConsistent(source.definitionJson, source.steps);
    const definition = normalizePortableDefinition(source.definitionJson);
    this.workflows.validateDefinitionForTemplate(definition);
    const dependencies = extractDependencies(definition);
    await this.classifySourceDependencies(organizationId, dependencies);
    const triggerHints = safeTriggerHints(source.materializedTriggerSnapshotJson);
    const warnings = triggerHints.length ? ["Operational triggers are not materialized and must be configured explicitly"] : [];
    return { definition, manifest: { schemaVersion: 1 as const, dependencies, triggerHints, warnings } };
  }

  private async classifySourceDependencies(organizationId: string, dependencies: TemplateDependency[]) {
    for (const dependency of dependencies) {
      if (dependency.classification !== "REQUIRES_MAPPING") continue;
      const id = dependency.sourceReference?.id;
      if (dependency.kind === "CONNECTION") {
        const found = id && await this.prisma.connection.findFirst({ where: { id, organizationId, type: dependency.expectedType as any, status: "ACTIVE", deletedAt: null }, select: { id: true } });
        if (!found) { dependency.classification = "MISSING"; dependency.message = "Source Connection is unavailable"; }
      } else if (dependency.kind === "DATA_STORE") {
        const found = await this.prisma.dataStore.findFirst({ where: { organizationId, deletedAt: null, ...(id ? { id } : { name: dependency.sourceReference?.name }) }, select: { id: true } });
        if (!found) { dependency.classification = "MISSING"; dependency.message = "Source Data Store is unavailable"; }
      } else {
        const found = id && await this.prisma.workflow.findFirst({ where: { id, organizationId }, select: { id: true } });
        if (!found) { dependency.classification = "MISSING"; dependency.message = "Source workflow target is unavailable"; }
      }
    }
  }

  private async buildPreview(organizationId: string, definition: Record<string, unknown>, manifest: DependencyManifest, mappings: Mapping[], initialBlockers: string[] = []) {
    const mappingKeys = new Set<string>();
    const resolved: Array<{ dependencyKey: string; targetResourceId: string; targetWorkflowVersionId?: string }> = [];
    const missing: TemplateDependency[] = [];
    const blockers: Array<{ code: string; message: string; dependencyKey?: string }> = initialBlockers.map((message) => ({ code: "template_unavailable", message }));
    for (const mapping of mappings) {
      if (mappingKeys.has(mapping.dependencyKey)) blockers.push({ code: "duplicate_mapping", message: "A dependency mapping was supplied more than once" });
      mappingKeys.add(mapping.dependencyKey);
      if (!manifest.dependencies.some((entry) => entry.dependencyKey === mapping.dependencyKey)) blockers.push({ code: "unknown_mapping", message: "A mapping does not match the dependency manifest" });
    }
    for (const dependency of manifest.dependencies) {
      if (["MISSING", "UNSUPPORTED"].includes(dependency.classification)) { blockers.push({ code: dependency.classification.toLowerCase(), message: dependency.message, dependencyKey: dependency.dependencyKey }); continue; }
      const mapping = mappings.find((entry) => entry.dependencyKey === dependency.dependencyKey);
      if (!mapping) { missing.push(dependency); blockers.push({ code: "mapping_required", message: dependency.message, dependencyKey: dependency.dependencyKey }); continue; }
      const valid = await this.validateMapping(organizationId, dependency, mapping);
      if (!valid) blockers.push({ code: "invalid_mapping", message: "Mapped resource is unavailable or incompatible", dependencyKey: dependency.dependencyKey });
      else resolved.push(mapping);
    }
    const mapped = applyMappings(definition, manifest.dependencies, resolved);
    if (!blockers.length) {
      try { await this.workflows.validateDefinitionForMaterialization(organizationId, mapped); }
      catch { blockers.push({ code: "validation_failed", message: "Mapped workflow definition failed validation" }); this.metrics.recordWorkflowTemplateValidationFailure("definition"); }
    }
    return { templateVersion: { schemaVersion: manifest.schemaVersion }, resourcesRequired: manifest.dependencies, mappingsResolved: resolved, mappingsMissing: missing, warnings: manifest.warnings, triggerHints: manifest.triggerHints, blockers, canInstantiate: blockers.length === 0, copied: ["Graph v2", "steps", "portable configuration", "declarative variables"], notCopied: ["secrets", "executions", "run history", "approvals", "runtime state", "operational triggers", "notification deliveries"], definition: mapped };
  }

  private async validateMapping(organizationId: string, dependency: TemplateDependency, mapping: Mapping) {
    if (dependency.kind === "CONNECTION") return Boolean(await this.prisma.connection.findFirst({ where: { id: mapping.targetResourceId, organizationId, type: dependency.expectedType as any, status: "ACTIVE", deletedAt: null }, select: { id: true } }));
    if (dependency.kind === "DATA_STORE") return Boolean(await this.prisma.dataStore.findFirst({ where: { id: mapping.targetResourceId, organizationId, deletedAt: null }, select: { id: true } }));
    const workflow = await this.prisma.workflow.findFirst({ where: { id: mapping.targetResourceId, organizationId }, select: { id: true, activeVersionId: true } });
    if (!workflow) return false;
    if (dependency.expectedType === "PINNED_VERSION") return Boolean(mapping.targetWorkflowVersionId && await this.prisma.workflowVersion.findFirst({ where: { id: mapping.targetWorkflowVersionId, workflowId: workflow.id, organizationId, activatedAt: { not: null }, status: { in: [WorkflowVersionStatus.ACTIVE, WorkflowVersionStatus.ARCHIVED] } }, select: { id: true } }));
    return Boolean(workflow.activeVersionId);
  }

  private async materialize(organizationId: string, userId: string, name: string, description: string | undefined, definition: Record<string, unknown>, auditMeta: Record<string, unknown>, templateGuard?: { templateId: string; versionId: string }) {
    await this.workflows.validateDefinitionForMaterialization(organizationId, definition);
    return this.prisma.$transaction(async (tx) => {
      if (templateGuard) {
        const available = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT v."id" FROM "workflow_template_versions" v JOIN "workflow_templates" t ON t."id" = v."template_id" WHERE v."id" = ${templateGuard.versionId} AND t."id" = ${templateGuard.templateId} AND t."organization_id" = ${organizationId} AND t."status" = 'PUBLISHED' AND v."published_at" IS NOT NULL FOR SHARE`);
        if (!available.length) throw new ConflictException("Template is no longer available for instantiation");
      }
      const workflow = await tx.workflow.create({ data: { organizationId, createdByUserId: userId, name: name.trim(), description: description?.trim() || null, status: WorkflowStatus.DRAFT } });
      const trigger = definition.trigger as Record<string, unknown>;
      const steps = definition.steps as Record<string, unknown>[];
      const version = await tx.workflowVersion.create({ data: { organizationId, workflowId: workflow.id, createdByUserId: userId, versionNumber: 1, status: WorkflowVersionStatus.DRAFT, definitionJson: json(definition), steps: { createMany: { data: [stepRow(organizationId, trigger, 0), ...steps.map((step, index) => stepRow(organizationId, step, index + 1))] } } }, include: { steps: { orderBy: { position: "asc" } } } });
      await this.audit.record({ organizationId, actorUserId: userId, action: String(auditMeta.action), resourceType: "Workflow", resourceId: workflow.id, metadata: { ...auditMeta, action: undefined, workflowVersionId: version.id } }, tx);
      return { ...workflow, versions: [version] };
    });
  }

  private async assertTemplate(organizationId: string, templateId: string) { const row = await this.prisma.workflowTemplate.findFirst({ where: { id: templateId, organizationId }, select: { id: true } }); if (!row) throw new NotFoundException("Workflow template not found"); }
  private async loadTemplateVersion(organizationId: string, templateId: string, versionId: string) { const row = await this.prisma.workflowTemplateVersion.findFirst({ where: { id: versionId, templateId, template: { organizationId } }, include: { template: true } }); if (!row) throw new NotFoundException("Workflow template version not found"); return row; }
}

const versionSelect = { id: true, templateId: true, versionNumber: true, dependencyManifestJson: true, sourceWorkflowId: true, sourceWorkflowVersionId: true, createdAt: true, publishedAt: true } as const;
function publicTemplate(row: any) { return { id: row.id, name: row.name, description: row.description, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy, versionCount: row._count?.versions ?? row.versions?.length, latestVersion: row.versions?.[0] }; }
function publicTemplateVersion(row: any) { return { id: row.id, templateId: row.templateId, versionNumber: row.versionNumber, definitionJson: row.definitionJson, dependencyManifestJson: row.dependencyManifestJson, sourceWorkflowId: row.sourceWorkflowId, sourceWorkflowVersionId: row.sourceWorkflowVersionId, createdAt: row.createdAt, publishedAt: row.publishedAt }; }
function stepRow(organizationId: string, step: Record<string, unknown>, position: number) { return { organizationId, key: String(step.key), name: String(step.name), type: String(step.type), position, configJson: json(step.config ?? {}), retryPolicyJson: step.retryPolicy ? json(step.retryPolicy) : undefined, timeoutSeconds: typeof step.timeoutSeconds === "number" ? step.timeoutSeconds : undefined }; }
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function assertSnapshotConsistent(definitionValue: unknown, rows: Array<{ key: string; type: string; configJson: unknown }>) { const definition = definitionValue && typeof definitionValue === "object" && !Array.isArray(definitionValue) ? definitionValue as Record<string, unknown> : {}; const logical = [definition.trigger, ...(Array.isArray(definition.steps) ? definition.steps : [])].filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))); if (logical.length !== rows.length || logical.some((step) => !rows.some((row) => row.key === step.key && row.type === step.type && JSON.stringify(row.configJson) === JSON.stringify(step.config ?? {})))) throw new ConflictException("Workflow version snapshot is inconsistent"); }
function mergeAutoMappings(dependencies: TemplateDependency[], explicit: Mapping[]) { const byKey = new Map(dependencies.flatMap((dependency) => dependency.sourceReference?.id ? [[dependency.dependencyKey, { dependencyKey: dependency.dependencyKey, targetResourceId: dependency.sourceReference.id, ...(dependency.sourceReference.workflowVersionId ? { targetWorkflowVersionId: dependency.sourceReference.workflowVersionId } : {}) } as Mapping]] : [])); for (const mapping of explicit) byKey.set(mapping.dependencyKey, mapping); return [...byKey.values()]; }
function encodeCursor(row: { id: string; updatedAt: Date }) { return Buffer.from(JSON.stringify({ id: row.id, updatedAt: row.updatedAt.toISOString() })).toString("base64url"); }
function decodeCursor(value?: string) { if (!value) return null; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); const updatedAt = new Date(parsed.updatedAt); if (!parsed.id || Number.isNaN(updatedAt.getTime())) throw new Error(); return { id: String(parsed.id), updatedAt }; } catch { throw new BadRequestException("Invalid template cursor"); } }
function encodeVersionCursor(row: { id: string; versionNumber: number }) { return Buffer.from(JSON.stringify({ id: row.id, versionNumber: row.versionNumber })).toString("base64url"); }
function decodeVersionCursor(value?: string) { if (!value) return null; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!parsed.id || !Number.isInteger(parsed.versionNumber)) throw new Error(); return { id: String(parsed.id), versionNumber: Number(parsed.versionNumber) }; } catch { throw new BadRequestException("Invalid template version cursor"); } }
