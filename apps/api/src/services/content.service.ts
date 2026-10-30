import { listLlmProviders, llmStatus } from '@surfaced/core/ai';
import {
  createContentVersion,
  exportHtml,
  exportMarkdown,
  latestVersion,
  suggestInternalLinks,
} from '@surfaced/core/content';
import { isWorkspaceParticipant } from '@surfaced/core/access';
import type { ContentVersion, Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord, toJobDto } from '@surfaced/core/jobs';
import { assertMonthlyQuota, withWorkspaceLock } from '@surfaced/core/usage';
import {
  TRANSITION_DENIAL_MESSAGES,
  allowedContentTransitions,
  can,
  checkContentTransition,
  isContentEditable,
  type ContentAccess,
  slugify,
  type BriefIdeasInput,
  type ContentBriefInput,
  type ContentDocumentCreateInput,
  type ContentDocumentUpdateInput,
  type ContentGenerateInput,
  type ContentStatus,
  type ContentVersionSaveInput,
  type FaqItem,
  type WorkspaceRole,
} from '@surfaced/shared';
import { iso, pageMeta, paginate, stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

type DocumentRow = Prisma.ContentDocumentGetPayload<{
  include: {
    assignee: { select: { id: true; name: true } };
    approvedBy: { select: { id: true; name: true } };
  };
}>;

function toVersionDto(v: ContentVersion) {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    title: v.title,
    body: v.body,
    outline: v.outline,
    metaTitle: v.metaTitle,
    metaDescription: v.metaDescription,
    faqs: v.faqs ?? [],
    internalLinks: v.internalLinks ?? [],
    schemaJsonLd: v.schemaJsonLd,
    wordCount: v.wordCount,
    source: v.source,
    provider: v.provider,
    model: v.model,
    isDevAdapter: v.isDevAdapter,
    note: v.note,
    createdById: v.createdById,
    createdAt: v.createdAt.toISOString(),
  };
}

function toDocumentDto(doc: DocumentRow, role: WorkspaceRole, access: ContentAccess = {}) {
  return {
    id: doc.id,
    projectId: doc.projectId,
    briefId: doc.briefId,
    title: doc.title,
    status: doc.status,
    wordCount: doc.wordCount,
    latestVersion: doc.latestVersion,
    targetUrl: doc.targetUrl,
    assignee: doc.assignee,
    approvedBy: doc.approvedBy,
    reviewRequestedAt: iso(doc.reviewRequestedAt),
    approvedAt: iso(doc.approvedAt),
    publishedAt: iso(doc.publishedAt),
    archivedAt: iso(doc.archivedAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    editable: isContentEditable(doc.status),
    allowedTransitions: allowedContentTransitions(doc.status, role, access),
  };
}

const documentInclude = {
  assignee: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
} as const;

export class ContentService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  // ---------------- Briefs ----------------

  async listBriefs(user: AuthUser, projectId: string, page: number, pageSize: number) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [total, rows] = await Promise.all([
      this.prisma.contentBrief.count({ where: { projectId } }),
      this.prisma.contentBrief.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { documents: true } } },
        ...paginate(page, pageSize),
      }),
    ]);
    return {
      items: rows.map(({ _count, ...b }) => ({ ...b, documentCount: _count.documents })),
      meta: pageMeta(page, pageSize, total),
    };
  }

  async createBrief(
    user: AuthUser,
    projectId: string,
    input: ContentBriefInput & { secondaryKeywords: string[] },
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'content.edit');
    return this.prisma.contentBrief.create({ data: { projectId, ...input } });
  }

  /** Every LLM provider the server can run brief/question generation on, for the client's provider selector. */
  async briefProviders(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return listLlmProviders();
  }

  /**
   * Generates an AI content-brief proposal (the real questions people ask + brief fields) for one topic, on the
   * chosen provider. Runs as a background job; the result is returned to the client to review, edit and save as a
   * brief. No measured metrics are produced.
   */
  async suggestBrief(user: AuthUser, projectId: string, input: BriefIdeasInput & { questionCount: number }) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'content.edit');
    // Confirm the chosen (or default) provider is configured before enqueuing, so it fails here, not as a dead job.
    const providers = listLlmProviders();
    const chosen = input.provider
      ? providers.find((p) => p.key === input.provider)
      : providers.find((p) => p.isDefault);
    if (!chosen?.configured) {
      throw Errors.providerNotConfigured(
        input.provider ? `Brief generation on ${chosen?.label ?? input.provider}` : 'Brief generation',
        chosen ?? llmStatus(),
      );
    }
    const job = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'CONTENT_GENERATION');
      return createJobRecord(tx, {
        type: 'CONTENT_GENERATION',
        queue: 'content',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'Project',
        entityId: projectId,
        payload: {
          projectId,
          seed: input.seed,
          country: input.country,
          language: input.language,
          questionCount: input.questionCount,
          provider: input.provider ?? null,
        },
        maxAttempts: 2,
      });
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'content', {
      backgroundJobId: job.id,
      kind: 'brief_ideas',
    });
    return { jobId: job.id, status: 'QUEUED' as const };
  }

  private async loadBrief(
    user: AuthUser,
    briefId: string,
    permission: 'project.read' | 'content.edit' | 'content.delete',
  ) {
    const brief = await this.prisma.contentBrief.findUnique({ where: { id: briefId } });
    if (!brief) throw Errors.notFound('Brief');
    const access = await requireProjectAccess(this.prisma, user, brief.projectId, permission);
    return { brief, ...access };
  }

  async getBrief(user: AuthUser, briefId: string) {
    const { brief } = await this.loadBrief(user, briefId, 'project.read');
    const documents = await this.prisma.contentDocument.findMany({
      where: { briefId },
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    return { ...brief, documents };
  }

  async updateBrief(user: AuthUser, briefId: string, input: Partial<ContentBriefInput>) {
    await this.loadBrief(user, briefId, 'content.edit');
    return this.prisma.contentBrief.update({
      where: { id: briefId },
      data: input as Prisma.ContentBriefUpdateInput,
    });
  }

  async deleteBrief(user: AuthUser, briefId: string) {
    await this.loadBrief(user, briefId, 'content.delete');
    await this.prisma.contentBrief.delete({ where: { id: briefId } });
  }

  // ---------------- Documents ----------------

  async listDocuments(
    user: AuthUser,
    projectId: string,
    query: { page: number; pageSize: number; status?: ContentStatus; q?: string },
  ) {
    const { role, via, approvalsDelegated } = await requireProjectAccess(
      this.prisma,
      user,
      projectId,
      'project.read',
    );
    const where: Prisma.ContentDocumentWhereInput = {
      projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { title: { contains: query.q } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.contentDocument.count({ where }),
      this.prisma.contentDocument.findMany({
        where,
        include: documentInclude,
        orderBy: { updatedAt: 'desc' },
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return {
      items: rows.map((d) => toDocumentDto(d, role, { via, approvalsDelegated })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  }

  async createDocument(
    user: AuthUser,
    projectId: string,
    input: ContentDocumentCreateInput & { title: string },
  ) {
    const { role, via, approvalsDelegated } = await requireProjectAccess(
      this.prisma,
      user,
      projectId,
      'content.edit',
    );
    if (input.briefId) {
      const brief = await this.prisma.contentBrief.findFirst({ where: { id: input.briefId, projectId } });
      if (!brief) throw Errors.badRequest('That brief does not belong to this project.');
    }
    const doc = await this.prisma.contentDocument.create({
      data: { projectId, briefId: input.briefId, title: input.title, targetUrl: input.targetUrl },
    });
    await createContentVersion(this.prisma, doc.id, {
      title: input.title,
      body: '',
      source: 'MANUAL',
      createdById: user.id,
      note: 'Document created',
    });
    return toDocumentDto(
      await this.prisma.contentDocument.findUniqueOrThrow({
        where: { id: doc.id },
        include: documentInclude,
      }),
      role,
      { via, approvalsDelegated },
    );
  }

  private async loadDocument(
    user: AuthUser,
    documentId: string,
    permission: 'project.read' | 'content.edit' | 'content.generate' | 'content.delete',
  ) {
    const doc = await this.prisma.contentDocument.findUnique({
      where: { id: documentId },
      include: documentInclude,
    });
    if (!doc) throw Errors.notFound('Document');
    const access = await requireProjectAccess(this.prisma, user, doc.projectId, permission);
    return { doc, ...access };
  }

  async getDocument(user: AuthUser, documentId: string) {
    const { doc, role, via, approvalsDelegated } = await this.loadDocument(user, documentId, 'project.read');
    const current = await latestVersion(this.prisma, documentId);
    const jobs = await this.prisma.backgroundJob.findMany({
      where: { entityType: 'ContentDocument', entityId: documentId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return {
      ...toDocumentDto(doc, role, { via, approvalsDelegated }),
      currentVersion: current ? toVersionDto(current) : null,
      recentJobs: jobs.map(toJobDto),
      generation: llmStatus(),
    };
  }

  async updateDocument(user: AuthUser, documentId: string, input: ContentDocumentUpdateInput) {
    // Read access is enough to reach the document: team edits need content.edit, and status changes follow the
    // workflow rules (clients may approve or send back content in review).
    const { doc, role, project, via, approvalsDelegated } = await this.loadDocument(
      user,
      documentId,
      'project.read',
    );
    const editsFields =
      input.title !== undefined || input.targetUrl !== undefined || input.assigneeId !== undefined;
    if (editsFields && !can(role, 'content.edit')) throw Errors.forbidden();
    const data: Prisma.ContentDocumentUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.targetUrl !== undefined) data.targetUrl = input.targetUrl;
    if (input.assigneeId !== undefined) {
      if (input.assigneeId) {
        if (!(await isWorkspaceParticipant(this.prisma, project.workspaceId, input.assigneeId)))
          throw Errors.badRequest('The assignee must be a member of this workspace.');
        data.assignee = { connect: { id: input.assigneeId } };
      } else {
        data.assignee = { disconnect: true };
      }
    }
    if (input.status && input.status !== doc.status) {
      const denial = checkContentTransition(doc.status, input.status, role, { via, approvalsDelegated });
      if (denial)
        throw denial === 'INVALID_TRANSITION'
          ? Errors.conflict(TRANSITION_DENIAL_MESSAGES[denial])
          : Errors.forbidden(TRANSITION_DENIAL_MESSAGES[denial]);
      data.status = input.status;
      const now = new Date();
      if (input.status === 'IN_REVIEW') data.reviewRequestedAt = now;
      if (input.status === 'APPROVED') {
        data.approvedAt = now;
        data.approvedBy = { connect: { id: user.id } };
      }
      if (input.status === 'PUBLISHED') data.publishedAt = now;
      if (input.status === 'ARCHIVED') data.archivedAt = now;
      if (input.status === 'DRAFT') {
        data.approvedAt = null;
        data.approvedBy = { disconnect: true };
      }
    }
    const updated = await this.prisma.contentDocument.update({
      where: { id: documentId },
      data,
      include: documentInclude,
    });
    return toDocumentDto(updated, role, { via, approvalsDelegated });
  }

  async deleteDocument(user: AuthUser, documentId: string) {
    await this.loadDocument(user, documentId, 'content.delete');
    await this.prisma.contentDocument.delete({ where: { id: documentId } });
  }

  // ---------------- Versions ----------------

  async listVersions(user: AuthUser, documentId: string) {
    await this.loadDocument(user, documentId, 'project.read');
    const versions = await this.prisma.contentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true,
        versionNumber: true,
        title: true,
        wordCount: true,
        source: true,
        provider: true,
        model: true,
        isDevAdapter: true,
        note: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    });
    return versions.map((v) => ({
      ...v,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy?.name ?? null,
    }));
  }

  async getVersion(user: AuthUser, documentId: string, versionId: string) {
    await this.loadDocument(user, documentId, 'project.read');
    const version = await this.prisma.contentVersion.findFirst({ where: { id: versionId, documentId } });
    if (!version) throw Errors.notFound('Version');
    return toVersionDto(version);
  }

  private assertEditable(status: ContentStatus) {
    if (!isContentEditable(status))
      throw Errors.conflict(
        'Approved, published or archived content must be moved back to draft before editing.',
      );
  }

  async saveVersion(user: AuthUser, documentId: string, input: ContentVersionSaveInput) {
    const { doc } = await this.loadDocument(user, documentId, 'content.edit');
    this.assertEditable(doc.status);
    const current = await latestVersion(this.prisma, documentId);
    const version = await createContentVersion(this.prisma, documentId, {
      title: input.title,
      body: input.body,
      outline: (current?.outline ?? null) as Prisma.InputJsonValue | null,
      metaTitle: input.metaTitle ?? current?.metaTitle ?? null,
      metaDescription: input.metaDescription ?? current?.metaDescription ?? null,
      faqs: (input.faqs ?? current?.faqs ?? null) as Prisma.InputJsonValue | null,
      internalLinks: (input.internalLinks ?? current?.internalLinks ?? null) as Prisma.InputJsonValue | null,
      schemaJsonLd: (input.schemaJsonLd ?? current?.schemaJsonLd ?? null) as Prisma.InputJsonValue | null,
      source: 'MANUAL',
      note: input.note ?? 'Edited',
      createdById: user.id,
    });
    return toVersionDto(version);
  }

  async restoreVersion(user: AuthUser, documentId: string, versionId: string) {
    const { doc } = await this.loadDocument(user, documentId, 'content.edit');
    this.assertEditable(doc.status);
    const source = await this.prisma.contentVersion.findFirst({ where: { id: versionId, documentId } });
    if (!source) throw Errors.notFound('Version');
    const version = await createContentVersion(this.prisma, documentId, {
      title: source.title,
      body: source.body,
      outline: (source.outline ?? null) as Prisma.InputJsonValue | null,
      metaTitle: source.metaTitle,
      metaDescription: source.metaDescription,
      faqs: (source.faqs ?? null) as Prisma.InputJsonValue | null,
      internalLinks: (source.internalLinks ?? null) as Prisma.InputJsonValue | null,
      schemaJsonLd: (source.schemaJsonLd ?? null) as Prisma.InputJsonValue | null,
      source: 'RESTORE',
      note: `Restored from version ${source.versionNumber}`,
      createdById: user.id,
    });
    return toVersionDto(version);
  }

  // ---------------- Generation ----------------

  async generate(user: AuthUser, documentId: string, input: ContentGenerateInput) {
    const { doc, project } = await this.loadDocument(user, documentId, 'content.generate');
    this.assertEditable(doc.status);
    if (input.mode !== 'schema' && !llmStatus().configured)
      throw Errors.providerNotConfigured('Content generation', llmStatus());
    const active = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'ContentDocument', entityId: documentId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (active) throw Errors.conflict('A generation job is already running for this document.');

    const job = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      if (input.mode !== 'schema') await assertMonthlyQuota(tx, project.workspaceId, 'CONTENT_GENERATION');
      return createJobRecord(tx, {
        type: 'CONTENT_GENERATION',
        queue: 'content',
        workspaceId: project.workspaceId,
        projectId: project.id,
        userId: user.id,
        entityType: 'ContentDocument',
        entityId: documentId,
        payload: {
          documentId,
          mode: input.mode,
          sectionHeading: input.sectionHeading,
          instructions: input.instructions,
          userId: user.id,
        },
        maxAttempts: 2,
      });
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'content', {
      backgroundJobId: job.id,
      kind: 'content_generation',
    });
    return { jobId: job.id, status: 'QUEUED' as const, mode: input.mode };
  }

  async internalLinks(user: AuthUser, documentId: string) {
    const { doc } = await this.loadDocument(user, documentId, 'project.read');
    const brief = doc.briefId
      ? await this.prisma.contentBrief.findUnique({ where: { id: doc.briefId } })
      : null;
    return suggestInternalLinks(this.prisma, doc.projectId, {
      keyword: brief?.primaryKeyword ?? doc.title,
      title: doc.title,
      secondary: stringArray(brief?.secondaryKeywords),
      excludeUrl: doc.targetUrl,
    });
  }

  async export(user: AuthUser, documentId: string, format: 'md' | 'html') {
    const { doc, project } = await this.loadDocument(user, documentId, 'project.read');
    const version = await latestVersion(this.prisma, documentId);
    if (!version) throw Errors.notFound('Version');
    const language = stringArray(project.targetLanguages)[0] ?? 'en';
    const input = {
      title: version.title,
      metaTitle: version.metaTitle,
      metaDescription: version.metaDescription,
      body: version.body,
      faqs: (Array.isArray(version.faqs) ? version.faqs : []) as unknown as FaqItem[],
      schemaJsonLd: version.schemaJsonLd,
      language,
    };
    const base = slugify(doc.title) || 'document';
    return format === 'html'
      ? { filename: `${base}.html`, contentType: 'text/html; charset=utf-8', body: exportHtml(input) }
      : { filename: `${base}.md`, contentType: 'text/markdown; charset=utf-8', body: exportMarkdown(input) };
  }
}
