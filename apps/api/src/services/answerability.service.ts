import { listLlmProviders, llmStatus } from '@surfaced/core/ai';
import type { Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord, toJobDto } from '@surfaced/core/jobs';
import { assertMonthlyQuota, withWorkspaceLock } from '@surfaced/core/usage';
import type { AnswerabilityRunInput } from '@surfaced/shared';
import { iso, pageMeta, paginate } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

type RunRow = Prisma.AnswerabilityRunGetPayload<object>;

function toRunDto(run: RunRow) {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    provider: run.provider,
    model: run.model,
    isDevAdapter: run.isDevAdapter,
    score: run.score,
    grade: run.grade,
    assessment: run.assessment,
    pagesConsidered: run.pagesConsidered,
    questionsConsidered: run.questionsConsidered,
    limitations: run.limitations ?? [],
    errorMessage: run.errorMessage,
    createdAt: iso(run.createdAt),
    finishedAt: iso(run.finishedAt),
  };
}

export class AnswerabilityService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  /** The LLM providers this server can run the answerability audit on (for the client's provider selector). */
  async providers(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return listLlmProviders();
  }

  async list(user: AuthUser, projectId: string, page: number, pageSize: number) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [total, rows] = await Promise.all([
      this.prisma.answerabilityRun.count({ where: { projectId } }),
      this.prisma.answerabilityRun.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        ...paginate(page, pageSize),
      }),
    ]);
    return { items: rows.map(toRunDto), meta: pageMeta(page, pageSize, total) };
  }

  /** The most recent run with its assessment, plus the latest background job so the client can show progress. */
  async latest(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const run = await this.prisma.answerabilityRun.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return { run: null, job: null };
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'AnswerabilityRun', entityId: run.id },
      orderBy: { createdAt: 'desc' },
    });
    return { run: toRunDto(run), job: job ? toJobDto(job) : null };
  }

  async detail(user: AuthUser, runId: string) {
    const run = await this.prisma.answerabilityRun.findUnique({
      where: { id: runId },
      select: { id: true, projectId: true },
    });
    if (!run) throw Errors.notFound('Answerability run');
    await requireProjectAccess(this.prisma, user, run.projectId, 'project.read');
    const full = await this.prisma.answerabilityRun.findUniqueOrThrow({ where: { id: runId } });
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'AnswerabilityRun', entityId: runId },
      orderBy: { createdAt: 'desc' },
    });
    return { ...toRunDto(full), job: job ? toJobDto(job) : null };
  }

  /** Starts an answerability analysis on the chosen (or default) provider. Needs a completed crawl to assess. */
  async run(user: AuthUser, projectId: string, input: AnswerabilityRunInput) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'audit.run');
    const providers = listLlmProviders();
    const chosen = input.provider
      ? providers.find((p) => p.key === input.provider)
      : providers.find((p) => p.isDefault);
    if (!chosen?.configured) {
      throw Errors.providerNotConfigured(
        input.provider ? `Answerability audit on ${chosen?.label ?? input.provider}` : 'Answerability audit',
        chosen ?? llmStatus(),
      );
    }
    const crawl = await this.prisma.crawlJob.findFirst({
      where: { projectId, status: 'SUCCEEDED' },
      select: { id: true },
    });
    if (!crawl)
      throw Errors.conflict(
        'Run a site audit first so there are crawled pages to assess for answerability.',
      );
    const active = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'AnswerabilityRun', projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (active) throw Errors.conflict('An answerability audit is already running for this project.');

    const created = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'CONTENT_GENERATION');
      const run = await tx.answerabilityRun.create({
        data: { projectId, provider: input.provider ?? null, createdById: user.id },
      });
      const job = await createJobRecord(tx, {
        type: 'AUDIT',
        queue: 'content',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'AnswerabilityRun',
        entityId: run.id,
        payload: { runId: run.id, projectId, provider: input.provider ?? null },
        maxAttempts: 2,
      });
      return { run, job };
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, created.job, 'content', {
      backgroundJobId: created.job.id,
      kind: 'answerability',
    });
    return { runId: created.run.id, jobId: created.job.id, status: 'QUEUED' as const };
  }
}
