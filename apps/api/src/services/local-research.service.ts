// Business research from collected local rankings: find a business by name across the project's collected searches,
// and research one listing — the comparison with the listings above it (computed, no AI) and an action plan from the
// chosen AI model. Uses one CONTENT_GENERATION unit per research, like other AI drafts. Nothing is published.
import { recordAuditLog } from '@surfaced/core/audit-log';
import { getLlmProvider, listLlmProviders, llmStatus, ProviderError } from '@surfaced/core/ai';
import type { LocalBusinessResearch, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import {
  buildResearchEvidence,
  captureBatchesDto,
  captureIdentityKey,
  findCollectedListings,
  otherSearchPositions,
  researchBusiness,
} from '@surfaced/core/local';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '@surfaced/core/usage';
import {
  listingSearchSchema,
  localResearchRunSchema,
  observationTypeForSource,
  parseGoogleSearchUrl,
  type ListingMatchDto,
  type LocalObservationType,
  type LocalRankSource,
  type LocalResearchDto,
  type LocalResearchEvidence,
  type LocalResearchReport,
  type LocalResearchRunInput,
  type LocalResearchSummaryDto,
  type LocalResult,
} from '@surfaced/shared';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

function summaryDto(row: LocalBusinessResearch): LocalResearchSummaryDto {
  const report = row.report as unknown as LocalResearchReport;
  return {
    id: row.id,
    scanId: row.scanId,
    resultIndex: row.resultIndex,
    businessKey: row.businessKey,
    businessName: row.businessName,
    position: row.position,
    pageLocal: row.pageLocal,
    query: row.query,
    provider: row.provider,
    model: row.model,
    isDevAdapter: row.isDevAdapter,
    actions: report.actions?.length ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export class LocalResearchService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  /** AI models available for research (for the client's model selector). */
  async providers(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return listLlmProviders();
  }

  /** Businesses whose name matches, with their position in each collected search (the latest of each). */
  async search(user: AuthUser, projectId: string, query: { q: string }): Promise<ListingMatchDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const { q } = listingSearchSchema.parse(query);
    return findCollectedListings(this.prisma, projectId, q);
  }

  async list(user: AuthUser, projectId: string, scanId: string): Promise<LocalResearchSummaryDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.localBusinessResearch.findMany({
      where: { projectId, scanId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(summaryDto);
  }

  async get(user: AuthUser, projectId: string, researchId: string): Promise<LocalResearchDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const row = await this.prisma.localBusinessResearch.findFirst({ where: { id: researchId, projectId } });
    if (!row) throw Errors.notFound('Research');
    return this.dto(row);
  }

  private async dto(row: LocalBusinessResearch): Promise<LocalResearchDto> {
    const author = row.createdById
      ? await this.prisma.user.findUnique({ where: { id: row.createdById }, select: { name: true } })
      : null;
    return {
      ...summaryDto(row),
      evidence: row.evidence as unknown as LocalResearchEvidence,
      report: row.report as unknown as LocalResearchReport,
      createdBy: author?.name ?? null,
    };
  }

  /** Researches one listing of a scan: the comparison, then the plan from the chosen (or default) AI model. */
  async run(
    user: AuthUser,
    projectId: string,
    scanId: string,
    input: LocalResearchRunInput,
  ): Promise<LocalResearchDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = localResearchRunSchema.parse(input);
    const scan = await this.prisma.localRankScan.findFirst({
      where: { id: scanId, projectId },
      include: { rankQuery: { include: { location: true } } },
    });
    if (!scan) throw Errors.notFound('Scan');
    const source = scan.source as LocalRankSource;
    const observationType = (scan.observationType as LocalObservationType | null) ?? observationTypeForSource(source); // prettier-ignore
    if (observationType !== 'observed_search_position')
      throw Errors.badRequest(
        'This scan’s order is not a search ranking (it is discovery order or an estimate). Research compares a business with the listings ranked above it, so it needs an observed ranking: saved Google pages, a manual record or an import.', // prettier-ignore
      );
    const point = await this.prisma.localRankPoint.findUnique({
      where: { scanId_row_col: { scanId, row: data.row, col: data.col } },
    });
    const results = (Array.isArray(point?.results) ? point.results : []) as unknown as LocalResult[];
    let index = data.resultIndex;
    const chosen = results[index];
    if (!chosen) throw Errors.badRequest('There is no listing at that position in this scan.');
    // An ad has no organic position; research the same business's organic listing when it has one.
    if (chosen.sponsored) {
      const key = captureIdentityKey(chosen);
      const organic = key ? results.findIndex((r) => !r.sponsored && captureIdentityKey(r) === key) : -1;
      if (organic < 0)
        throw Errors.badRequest(
          'This business appears only as an ad in this collection. Ads are bought, not ranked, so there is no organic position to research.', // prettier-ignore
        );
      index = organic;
    }

    const providers = listLlmProviders();
    const picked = data.provider ? providers.find((p) => p.key === data.provider) : providers.find((p) => p.isDefault); // prettier-ignore
    if (!picked?.configured)
      throw Errors.providerNotConfigured(
        data.provider ? `Research on ${picked?.label ?? data.provider}` : 'Research',
        picked ?? llmStatus(),
      );
    const llm = getLlmProvider(data.provider ?? undefined);
    if (!llm) throw Errors.providerNotConfigured('Research', llmStatus());
    await assertMonthlyQuota(this.prisma, project.workspaceId, 'CONTENT_GENERATION', 1);

    const listing = results[index]!;
    const businessKey = (captureIdentityKey(listing) ?? `i:${index}`).slice(0, 512);
    const firstUrl = captureBatchesDto(scan.captureBatches).find((b) => b.url)?.url;
    const fromUrl = firstUrl ? parseGoogleSearchUrl(firstUrl) : null;
    const location = (fromUrl?.ok ? fromUrl.info.location : null) ?? scan.rankQuery.location.city ?? null;
    const evidence = buildResearchEvidence({
      results,
      index,
      query: scan.query,
      location,
      source,
      observationType,
      capturedAt: point?.checkedAt ?? scan.finishedAt ?? scan.createdAt,
      otherSearches: businessKey.startsWith('i:') ? [] : await otherSearchPositions(this.prisma, projectId, scan, businessKey), // prettier-ignore
    });
    let result;
    try {
      result = await researchBusiness(llm, evidence);
    } catch (error) {
      if (error instanceof ProviderError) throw Errors.upstream(`The research failed: ${error.message}`);
      throw error;
    }
    const target = evidence.target;
    const row = await this.prisma.localBusinessResearch.create({
      data: {
        projectId,
        scanId,
        resultIndex: index,
        businessKey,
        businessName: target.title.slice(0, 255),
        query: scan.query.slice(0, 200),
        position: target.pageLocal ? target.position : (target.organicPosition ?? target.position),
        pageLocal: target.pageLocal,
        evidence: evidence as unknown as object,
        report: result.report as unknown as object,
        provider: result.provider.slice(0, 20),
        model: (result.isDevAdapter ? 'dev-template' : result.model).slice(0, 80),
        isDevAdapter: result.isDevAdapter,
        createdById: user.id,
      },
    });
    await withWorkspaceLock(this.prisma, project.workspaceId, (tx) =>
      recordUsage(tx, { workspaceId: project.workspaceId, projectId, metric: 'CONTENT_GENERATION', quantity: 1, idempotencyKey: `local-research:${row.id}` }),
    ); // prettier-ignore
    await recordAuditLog(this.prisma, {
      action: 'local_research.generated',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'LocalRankScan',
      targetId: scanId,
      metadata: { business: row.businessName, position: row.position, actions: result.report.actions.length, model: row.model }, // prettier-ignore
    });
    return this.dto(row);
  }
}
