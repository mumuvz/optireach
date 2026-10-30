import { listLlmProviders, llmStatus } from '@surfaced/core/ai';
import type { Prisma, PrismaClient } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import {
  keywordOpportunities,
  keywordsToCsv,
  normalizePhrase,
  parseKeywordCsv,
} from '@surfaced/core/keywords';
import { assertMonthlyQuota, withWorkspaceLock } from '@surfaced/core/usage';
import type {
  KeywordGroupInput,
  KeywordListQuery,
  KeywordSuggestInput,
  KeywordUpdateInput,
} from '@surfaced/shared';
import { type z } from 'zod';
import { type keywordInputSchema } from '@surfaced/shared';
import { iso, pageMeta, paginate, stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

type KeywordData = z.output<typeof keywordInputSchema>;
type KeywordRow = Prisma.ProjectKeywordGetPayload<{
  include: { list: { select: { id: true; name: true } }; cluster: { select: { id: true; name: true } } };
}>;

export function toKeywordDto(k: KeywordRow) {
  return {
    id: k.id,
    phrase: k.phrase,
    intent: k.intent,
    country: k.country,
    language: k.language,
    priority: k.priority,
    status: k.status,
    isPrimary: k.isPrimary,
    relatedQuestions: stringArray(k.relatedQuestions),
    targetUrl: k.targetUrl,
    notes: k.notes,
    source: k.source,
    list: k.list,
    cluster: k.cluster,
    // Measured metrics: null unless a licensed provider supplied them.
    metrics: k.metricsSource
      ? {
          searchVolume: k.searchVolume,
          difficulty: k.difficulty,
          cpc: k.cpc?.toString() ?? null,
          currency: k.metricsCurrency,
          source: k.metricsSource,
          fetchedAt: iso(k.metricsFetchedAt),
        }
      : null,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

const include = {
  list: { select: { id: true, name: true } },
  cluster: { select: { id: true, name: true } },
} as const;

export class KeywordService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  providerStatus() {
    const env = getEnv();
    return {
      keywordData: {
        provider: env.KEYWORD_DATA_PROVIDER,
        configured: false,
        detail:
          'No licensed keyword-data provider is configured. Search volume, difficulty, CPC and rankings are not shown and are never estimated.',
      },
      suggestions: llmStatus(),
      // Every LLM provider the server can run research on, so the client can offer each configured one and
      // compare their ideas. `isDefault` marks the one used when no provider is chosen.
      llmProviders: listLlmProviders(),
    };
  }

  private async assertGroupsBelong(projectId: string, listId?: string | null, clusterId?: string | null) {
    if (listId && !(await this.prisma.keywordList.count({ where: { id: listId, projectId } })))
      throw Errors.badRequest('That keyword list does not belong to this project.');
    if (clusterId && !(await this.prisma.topicCluster.count({ where: { id: clusterId, projectId } })))
      throw Errors.badRequest('That topic cluster does not belong to this project.');
  }

  async list(user: AuthUser, projectId: string, query: KeywordListQuery) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where: Prisma.ProjectKeywordWhereInput = { projectId };
    if (query.q) where.phrase = { contains: query.q };
    if (query.listId) where.listId = query.listId;
    if (query.clusterId) where.clusterId = query.clusterId;
    if (query.intent) where.intent = query.intent;
    if (query.priority) where.priority = query.priority;
    if (query.status) where.status = query.status;
    if (query.primary) where.isPrimary = query.primary === 'true';
    const [total, rows] = await Promise.all([
      this.prisma.projectKeyword.count({ where }),
      this.prisma.projectKeyword.findMany({
        where,
        include,
        orderBy: { [query.sort]: query.order },
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return { items: rows.map(toKeywordDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async create(
    user: AuthUser,
    projectId: string,
    input: KeywordData,
    source: 'MANUAL' | 'AI_SUGGESTION' = 'MANUAL',
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    await this.assertGroupsBelong(projectId, input.listId, input.clusterId);
    const normalizedPhrase = normalizePhrase(input.phrase);
    const exists = await this.prisma.projectKeyword.findUnique({
      where: {
        projectId_normalizedPhrase_country_language: {
          projectId,
          normalizedPhrase,
          country: input.country,
          language: input.language,
        },
      },
    });
    if (exists)
      throw Errors.conflict(`"${input.phrase}" is already tracked for ${input.country}/${input.language}.`);
    const created = await this.prisma.projectKeyword.create({
      data: { projectId, ...input, normalizedPhrase, source, relatedQuestions: input.relatedQuestions },
      include,
    });
    return toKeywordDto(created);
  }

  async bulkCreate(
    user: AuthUser,
    projectId: string,
    keywords: KeywordData[],
    source: 'MANUAL' | 'AI_SUGGESTION',
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    for (const k of keywords) await this.assertGroupsBelong(projectId, k.listId, k.clusterId);
    const result = await this.prisma.projectKeyword.createMany({
      data: keywords.map((k) => ({
        projectId,
        ...k,
        normalizedPhrase: normalizePhrase(k.phrase),
        source,
        relatedQuestions: k.relatedQuestions,
      })),
      skipDuplicates: true,
    });
    return { created: result.count, skipped: keywords.length - result.count };
  }

  private async load(user: AuthUser, keywordId: string) {
    const keyword = await this.prisma.projectKeyword.findUnique({ where: { id: keywordId } });
    if (!keyword) throw Errors.notFound('Keyword');
    await requireProjectAccess(this.prisma, user, keyword.projectId, 'keyword.manage');
    return keyword;
  }

  async update(user: AuthUser, keywordId: string, input: KeywordUpdateInput & { targetUrl?: string | null }) {
    const keyword = await this.load(user, keywordId);
    await this.assertGroupsBelong(keyword.projectId, input.listId, input.clusterId);
    const data: Prisma.ProjectKeywordUncheckedUpdateInput = {
      intent: input.intent,
      priority: input.priority,
      status: input.status,
      listId: input.listId,
      clusterId: input.clusterId,
      relatedQuestions: input.relatedQuestions,
      targetUrl: input.targetUrl,
      notes: input.notes,
      isPrimary: input.isPrimary,
    };
    if (input.phrase) {
      data.phrase = input.phrase;
      data.normalizedPhrase = normalizePhrase(input.phrase);
    }
    const updated = await this.prisma.projectKeyword.update({ where: { id: keywordId }, data, include });
    return toKeywordDto(updated);
  }

  async remove(user: AuthUser, keywordId: string) {
    await this.load(user, keywordId);
    await this.prisma.projectKeyword.delete({ where: { id: keywordId } });
  }

  async importCsv(
    user: AuthUser,
    projectId: string,
    input: { csv: string; defaultCountry: string; defaultLanguage: string; listId?: string },
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    await this.assertGroupsBelong(projectId, input.listId, null);
    const parsed = parseKeywordCsv(input.csv, {
      country: input.defaultCountry,
      language: input.defaultLanguage,
    });
    const groupIds = async (kind: 'cluster' | 'list', names: string[]) => {
      const map = new Map<string, string>();
      for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 200)) {
        const row =
          kind === 'cluster'
            ? await this.prisma.topicCluster.upsert({
                where: { projectId_name: { projectId, name: name.slice(0, 120) } },
                update: {},
                create: { projectId, name: name.slice(0, 120) },
              })
            : await this.prisma.keywordList.upsert({
                where: { projectId_name: { projectId, name: name.slice(0, 120) } },
                update: {},
                create: { projectId, name: name.slice(0, 120) },
              });
        map.set(name, row.id);
      }
      return map;
    };
    const clusters = await groupIds(
      'cluster',
      parsed.rows.map((r) => r.cluster ?? ''),
    );
    const lists = await groupIds(
      'list',
      parsed.rows.map((r) => r.list ?? ''),
    );
    const data = parsed.rows.map(({ cluster, list, ...row }) => ({
      projectId,
      ...row,
      normalizedPhrase: normalizePhrase(row.phrase),
      source: 'CSV_IMPORT' as const,
      clusterId: cluster ? clusters.get(cluster.trim()) : undefined,
      listId: (list ? lists.get(list.trim()) : undefined) ?? input.listId,
    }));
    const result = data.length
      ? await this.prisma.projectKeyword.createMany({ data, skipDuplicates: true })
      : { count: 0 };
    return {
      totalRows: parsed.totalRows,
      created: result.count,
      skipped: data.length - result.count,
      errors: parsed.errors.slice(0, 100),
    };
  }

  async exportCsv(user: AuthUser, projectId: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.projectKeyword.findMany({
      where: { projectId },
      include,
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    const csv = keywordsToCsv(
      rows.map((k) => ({
        phrase: k.phrase,
        intent: k.intent,
        priority: k.priority,
        status: k.status,
        country: k.country,
        language: k.language,
        cluster: k.cluster?.name ?? null,
        list: k.list?.name ?? null,
        targetUrl: k.targetUrl,
        relatedQuestions: stringArray(k.relatedQuestions),
        notes: k.notes,
        searchVolume: k.metricsSource ? k.searchVolume : null,
        difficulty: k.metricsSource ? k.difficulty : null,
        cpc: k.metricsSource ? (k.cpc?.toString() ?? null) : null,
        metricsSource: k.metricsSource,
      })),
    );
    return { filename: `${project.domain}-keywords.csv`, csv };
  }

  async suggest(user: AuthUser, projectId: string, input: KeywordSuggestInput & { count: number }) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    // Pick the provider the request chose, or the server default, and confirm it is configured before enqueuing
    // (so a provider with no key fails immediately here, not later as a dead job).
    const providers = listLlmProviders();
    const chosen = input.provider
      ? providers.find((p) => p.key === input.provider)
      : providers.find((p) => p.isDefault);
    if (!chosen?.configured) {
      throw Errors.providerNotConfigured(
        input.provider ? `Keyword suggestions on ${chosen?.label ?? input.provider}` : 'Keyword suggestions',
        chosen ?? llmStatus(),
      );
    }
    const job = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'KEYWORD_SUGGESTION');
      return createJobRecord(tx, {
        type: 'KEYWORD_SUGGESTIONS',
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
          count: input.count,
          provider: input.provider ?? null,
        },
        maxAttempts: 2,
      });
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'content', {
      backgroundJobId: job.id,
      kind: 'keyword_suggestions',
    });
    return { jobId: job.id, status: 'QUEUED' as const };
  }

  /** Explainable opportunity scores from the signals each keyword actually has. */
  async opportunities(user: AuthUser, projectId: string, limit: number) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return keywordOpportunities(this.prisma, projectId, { limit });
  }

  // ---------------- Lists and clusters ----------------

  async listGroups(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [lists, clusters] = await Promise.all([
      this.prisma.keywordList.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
        include: { _count: { select: { keywords: true } } },
      }),
      this.prisma.topicCluster.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
        include: { _count: { select: { keywords: true } } },
      }),
    ]);
    return {
      lists: lists.map(({ _count, ...l }) => ({ ...l, keywordCount: _count.keywords })),
      clusters: clusters.map(({ _count, ...c }) => ({ ...c, keywordCount: _count.keywords })),
    };
  }

  async createGroup(
    user: AuthUser,
    projectId: string,
    kind: 'list' | 'cluster',
    input: KeywordGroupInput & { pillarUrl?: string },
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    try {
      return kind === 'list'
        ? await this.prisma.keywordList.create({
            data: { projectId, name: input.name, description: input.description },
          })
        : await this.prisma.topicCluster.create({
            data: { projectId, name: input.name, description: input.description, pillarUrl: input.pillarUrl },
          });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw Errors.conflict(`A ${kind} named "${input.name}" already exists.`);
      throw error;
    }
  }

  async deleteGroup(user: AuthUser, projectId: string, kind: 'list' | 'cluster', id: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const result =
      kind === 'list'
        ? await this.prisma.keywordList.deleteMany({ where: { id, projectId } })
        : await this.prisma.topicCluster.deleteMany({ where: { id, projectId } });
    if (result.count === 0) throw Errors.notFound(kind === 'list' ? 'Keyword list' : 'Topic cluster');
  }
}
