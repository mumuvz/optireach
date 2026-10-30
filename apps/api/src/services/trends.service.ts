import { llmStatus } from '@surfaced/core/ai';
import type { PrismaClient, TrendReport } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { normalizePhrase } from '@surfaced/core/keywords';
import {
  TREND_LIVE_PREFERENCE,
  TREND_REPORTS_PER_PROJECT_PER_DAY,
  createTrendReport,
  describeTrendPlace,
  findCachedTrendReport,
  getTrendsProvider,
  googleTrendsCategories,
  isTrendSourceEnabled,
  liveReportsToday,
  loadTrendData,
  nextTrendRun,
  saveTrendPlacementAsRecommendation,
  searchConsoleStatus,
  trendCacheKey,
  trendProviderStatuses,
  trendReportCsv,
  trendSourceLimitations,
} from '@surfaced/core/trends';
import {
  TREND_SOURCES,
  TREND_SOURCE_LABELS,
  TREND_TIME_RANGES,
  buildTrendsImport,
  termWithCity,
  googleTrendsExploreUrl,
  trendSourceType,
  type TrendAnalysisResult,
  type TrendData,
  type TrendDataType,
  type TrendExportPart,
  type TrendImportInput,
  type TrendLiveSource,
  type TrendReportDto,
  type TrendReportSummaryDto,
  type TrendSaveKeywordsInput,
  type TrendSavedQueryDto,
  type TrendSavedQueryInput,
  type TrendSchedule,
  type TrendSettings,
  type TrendSource,
  type TrendTimeRange,
  type TrendsStatusDto,
} from '@surfaced/shared';
import { iso, stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

const SAVED_QUERIES_PER_PROJECT = 20;

const unique = (items: string[]) => [...new Set(items)];

function sourceOf(value: string): TrendSource {
  return (TREND_SOURCES as readonly string[]).includes(value) ? (value as TrendSource) : 'CSV_IMPORT';
}

function periodLabel(timeRange: string): string {
  return TREND_TIME_RANGES.find((t) => t.key === timeRange)?.label ?? timeRange;
}

export class TrendsService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  async status(user: AuthUser, projectId: string): Promise<TrendsStatusDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const providers = await trendProviderStatuses(this.prisma);
    const llm = llmStatus();
    const gsc = await searchConsoleStatus(this.prisma, projectId);
    const env = getEnv();
    return {
      providers,
      defaultProvider:
        TREND_LIVE_PREFERENCE.find((key) => providers.find((p) => p.key === key)?.available) ?? null,
      searchConsole: {
        ...gsc,
        detail: gsc.connected
          ? 'Your own measured clicks and impressions are shown next to Google Trends interest, never combined with it.'
          : 'Connect Google Search Console (Integrations) to see your own clicks and impressions for these searches.',
      },
      keywordPlanner: {
        configured: false,
        detail:
          'Google Ads Keyword Planner is not connected. It needs a Google Ads developer token, OAuth access and an active Ads account, and it reports volumes as ranges. Search volumes are never estimated here.',
      },
      ai: { configured: llm.configured && !llm.isDevAdapter, detail: llm.detail },
      limits: {
        liveReportsPerWorkspacePerDay: env.TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY,
        liveReportsToday: await liveReportsToday(this.prisma, project.workspaceId),
        reportsPerProjectPerDay: TREND_REPORTS_PER_PROJECT_PER_DAY,
      },
    };
  }

  async categories(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return googleTrendsCategories();
  }

  async list(user: AuthUser, projectId: string): Promise<TrendReportSummaryDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.trendReport.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => this.summary(r));
  }

  async get(user: AuthUser, projectId: string, reportId: string): Promise<TrendReportDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return this.toDto(await this.load(projectId, reportId));
  }

  async latest(user: AuthUser, projectId: string): Promise<TrendReportDto | null> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const report = await this.prisma.trendReport.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return report ? this.toDto(report) : null;
  }

  private async load(projectId: string, reportId: string) {
    const report = await this.prisma.trendReport.findFirst({ where: { id: reportId, projectId } });
    if (!report) throw Errors.notFound('Trends report');
    return report;
  }

  /** Live Google Trends data from the chosen (or default) provider, then the comparison with the site. */
  async fetchLive(
    user: AuthUser,
    projectId: string,
    settings: TrendSettings,
    savedQueryId: string | null = null,
  ) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const source = settings.provider ?? (await this.defaultSource());
    if (!source)
      throw Errors.providerNotConfigured('Live Google Trends data', {
        setup:
          'Start the pytrends service and set PYTRENDS_SERVICE_URL (free, experimental), or add DataForSEO credentials (paid), or import CSV files exported from Google Trends.',
      });
    const label = TREND_SOURCE_LABELS[source];
    if (!isTrendSourceEnabled(source)) throw Errors.badRequest(`${label} is turned off on this server.`);
    const provider = getTrendsProvider(source);
    const config = provider.configured();
    if (!config.configured || !provider.fetch)
      throw Errors.providerNotConfigured(label, { setup: config.detail });
    if (settings.region && !provider.meta.capabilities.subregions)
      throw Errors.badRequest(`${label} does not support sub-regions here; choose the whole country or another source.`); // prettier-ignore
    const language = stringArray(project.targetLanguages)[0] ?? 'en';
    // A city filter compares searches that mention the city (Google Trends cannot filter to one city).
    const keywords = [...new Set(settings.keywords.map((k) => termWithCity(k, settings.city)))];
    const request = { source, keywords, country: settings.country, region: settings.region, city: settings.city, timeRange: settings.timeRange, category: settings.category, language, include: settings.include as TrendDataType[] }; // prettier-ignore
    // Data still cached from an identical request needs no call to the provider, so it works even while it is down.
    const cached = await findCachedTrendReport(this.prisma, trendCacheKey(request));
    if (!cached && provider.health) {
      const health = await provider.health();
      if (health.coolingDownSeconds > 0)
        throw Errors.rateLimited(`Google Trends is rate-limiting requests from this server; try again in about ${Math.max(1, Math.ceil(health.coolingDownSeconds / 60))} minutes, or import a CSV from Google Trends.`); // prettier-ignore
      if (!health.ok) throw Errors.unavailable(`${label} is not available right now: ${health.lastError ?? 'unknown error'}.`); // prettier-ignore
    }
    return createTrendReport(this.prisma, this.deps.queues, {
      ...request,
      projectId,
      workspaceId: project.workspaceId,
      userId: user.id,
      suggestPlacements: settings.suggestPlacements,
      trigger: 'MANUAL',
      savedQueryId,
    });
  }

  private async defaultSource(): Promise<TrendLiveSource | null> {
    const statuses = await trendProviderStatuses(this.prisma);
    return TREND_LIVE_PREFERENCE.find((key) => statuses.find((p) => p.key === key)?.available) ?? null;
  }

  /** Reads exported files without saving anything, so the user can check them first. */
  async previewImport(user: AuthUser, projectId: string, input: TrendImportInput) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const { data: _data, ...preview } = buildTrendsImport(input.files, { keywords: input.keywords });
    return preview;
  }

  /** CSV files the user exported from trends.google.com, then the comparison with the site. */
  async importCsv(user: AuthUser, projectId: string, input: TrendImportInput) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    if (!isTrendSourceEnabled('CSV_IMPORT'))
      throw Errors.badRequest('CSV import is turned off on this server.');
    const preview = buildTrendsImport(input.files, { keywords: input.keywords });
    if (!preview.ok)
      throw Errors.badRequest(
        'These files could not be read. In Google Trends, download a chart (the download icon on “Interest over time”, “Interest by subregion” or “Related queries”) as CSV and upload the file unchanged.',
        { files: preview.files.map((f) => ({ name: f.name, error: f.error })) },
      );
    const data = preview.data;
    const include: TrendDataType[] = [
      ...(data.interest ? (['interest'] as const) : []),
      ...(data.regions ? (['regions'] as const) : []),
      ...(data.related.length ? (['related_queries'] as const) : []),
      ...(data.topics?.length ? (['related_topics'] as const) : []),
    ];
    return createTrendReport(this.prisma, this.deps.queues, {
      projectId,
      workspaceId: project.workspaceId,
      userId: user.id,
      source: 'CSV_IMPORT',
      keywords: preview.keywords,
      country: input.country ?? null,
      region: input.region ?? null,
      timeRange: input.timeRange ?? 'past_90_days',
      category: input.category ?? 0,
      language: stringArray(project.targetLanguages)[0] ?? 'en',
      include,
      suggestPlacements: input.suggestPlacements ?? true,
      trigger: 'MANUAL',
      data,
      imports: preview.files
        .filter((f) => f.kind)
        .map((f) => ({ fileName: f.name, kind: f.kind!, keywords: f.keywords, headerNote: f.headerNote, rowCount: f.rows })), // prettier-ignore
    });
  }

  async exportCsv(user: AuthUser, projectId: string, reportId: string, part: TrendExportPart) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const report = await this.load(projectId, reportId);
    const data = await loadTrendData(this.prisma, report);
    const csv = trendReportCsv(
      { ...report, source: sourceOf(report.source) },
      data,
      (report.analysis as unknown as TrendAnalysisResult | null) ?? null,
      part,
    );
    return {
      filename: `${project.domain}-trends-${part}-${report.createdAt.toISOString().slice(0, 10)}.csv`,
      csv,
    };
  }

  /** Every term a report knows: the compared terms, related queries and the analysed terms. */
  private reportTerms(report: TrendReport, data: TrendData | null, analysis: TrendAnalysisResult | null) {
    const terms = new Map<string, { term: string; rising: string | null }>();
    const add = (term: string, rising: string | null = null) => {
      const key = term.trim().toLowerCase();
      if (key && !terms.has(key)) terms.set(key, { term: term.trim(), rising });
    };
    stringArray(report.keywords).forEach((k) => add(k));
    for (const t of analysis?.terms ?? []) add(t.term, t.rising);
    for (const g of data?.related ?? []) {
      g.top.forEach((q) => add(q.query));
      g.rising.forEach((q) => add(q.query, q.value));
    }
    return terms;
  }

  /** Adds report terms to the project's keywords, optionally in a keyword list (collection). */
  async saveKeywords(user: AuthUser, projectId: string, reportId: string, input: TrendSaveKeywordsInput) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const report = await this.load(projectId, reportId);
    if (report.status !== 'SUCCEEDED') throw Errors.conflict('The report is not finished yet.');
    const data = await loadTrendData(this.prisma, report);
    const analysis = (report.analysis as unknown as TrendAnalysisResult | null) ?? null;
    const known = this.reportTerms(report, data, analysis);
    const terms = unique(input.terms.map((t) => t.trim()));
    const found = terms.map((t) => known.get(t.toLowerCase())).filter((t): t is { term: string; rising: string | null } => Boolean(t)); // prettier-ignore
    const unknown = terms.filter((t) => !known.has(t.toLowerCase()));
    if (!found.length) throw Errors.badRequest('None of these terms are in this report.');

    let listId: string | null = null;
    if (input.listId) {
      const list = await this.prisma.keywordList.findFirst({ where: { id: input.listId, projectId } });
      if (!list) throw Errors.badRequest('That keyword list does not belong to this project.');
      listId = list.id;
    } else if (input.listName) {
      const list = await this.prisma.keywordList.upsert({
        where: { projectId_name: { projectId, name: input.listName } },
        update: {},
        create: { projectId, name: input.listName, description: 'Saved from Keyword trends' },
      });
      listId = list.id;
    }
    const source = sourceOf(report.source);
    const country = report.country ?? stringArray(project.targetCountries)[0] ?? 'US';
    const language = report.language;
    const provenance = `From Google Trends (${TREND_SOURCE_LABELS[source]}), ${describeTrendPlace(report.country, report.region, report.city)}, ${periodLabel(report.timeRange).toLowerCase()}, retrieved ${report.fetchedAt?.toISOString().slice(0, 10) ?? 'unknown date'}.`; // prettier-ignore
    const rows = found.map((t) => ({
      projectId,
      phrase: t.term.slice(0, 200),
      normalizedPhrase: normalizePhrase(t.term).slice(0, 200),
      country,
      language,
      priority: input.priority ?? 'MEDIUM',
      status: 'IDEA' as const,
      source: trendSourceType(source) === 'CSV' ? ('CSV_IMPORT' as const) : ('PROVIDER' as const),
      notes: `${provenance}${t.rising ? ` Rising related search (${t.rising}).` : ''}`.slice(0, 1000),
      listId,
    }));
    const created = await this.prisma.projectKeyword.createMany({ data: rows, skipDuplicates: true });
    // Keywords that already existed join the list too, when one was chosen (their other details are kept).
    if (listId)
      await this.prisma.projectKeyword.updateMany({
        where: { projectId, country, language, listId: null, normalizedPhrase: { in: rows.map((r) => r.normalizedPhrase) } }, // prettier-ignore
        data: { listId },
      });
    return { created: created.count, skipped: rows.length - created.count, unknown, listId };
  }

  /** Plans content for a term: a content brief with the trend evidence, and a task when a due date is given. */
  async createBrief(
    user: AuthUser,
    projectId: string,
    reportId: string,
    input: { term: string; dueDate?: Date },
  ) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'content.edit');
    if (input.dueDate) await requireProjectAccess(this.prisma, user, projectId, 'task.manage');
    const report = await this.load(projectId, reportId);
    const analysis = (report.analysis as unknown as TrendAnalysisResult | null) ?? null;
    if (report.status !== 'SUCCEEDED' || !analysis) throw Errors.conflict('The report is not finished yet.');
    const term = analysis.terms.find((t) => t.term.toLowerCase() === input.term.trim().toLowerCase());
    if (!term) throw Errors.notFound('Term');
    const data = await loadTrendData(this.prisma, report);
    const placement = analysis.placements.find((p) => p.term === term.term);
    const words = term.term.toLowerCase().split(/\s+/);
    const related = unique(
      (data?.related ?? [])
        .flatMap((g) =>
          g.keyword?.toLowerCase() === term.term.toLowerCase()
            ? g.top.map((q) => q.query)
            : g.top.map((q) => q.query).filter((q) => words.some((w) => q.toLowerCase().includes(w))),
        ) // prettier-ignore
        .filter((q) => q.toLowerCase() !== term.term.toLowerCase()),
    ).slice(0, 8);
    const question = /^(how|what|why|when|where|which|who|can|is|are|does|do|should)\b/i.test(term.term);
    const commercial = /\b(buy|price|cost|cheap|online|order|maker|templates?|services?|shop|app)\b/i.test(
      term.term,
    );
    const source = sourceOf(report.source);
    const notes = [
      `From Keyword trends: ${TREND_SOURCE_LABELS[source]}, ${describeTrendPlace(report.country, report.region, report.city)}, ${periodLabel(report.timeRange).toLowerCase()}, retrieved ${report.fetchedAt?.toISOString().slice(0, 10) ?? 'unknown date'}.`, // prettier-ignore
      term.rising ? `Rising related search: ${term.rising}.` : term.interest !== null ? `Relative interest: ${Math.round(term.interest)}/100 (not a search count).` : '', // prettier-ignore
      term.direction && term.direction !== 'no_data' ? `Interest over the period: ${term.direction}.` : '',
      term.searchConsole ? `Search Console: ${term.searchConsole.impressions} impressions, ${term.searchConsole.clicks} clicks, average position ${term.searchConsole.position} (${term.searchConsole.rangeStart} to ${term.searchConsole.rangeEnd}).` : '', // prettier-ignore
      `Your site: ${term.status === 'present' ? 'already targeted' : term.status === 'partial' ? 'mentioned but not targeted' : 'not covered'}.`,
      placement ? `Suggested placement (AI-written; check every claim): ${placement.pageUrl ? `${placement.pageUrl}${placement.section ? `, section “${placement.section}”` : ''}` : 'a new page'} as ${placement.spot.replace('_', ' ')}: “${placement.suggestedText}”` : '', // prettier-ignore
    ].filter(Boolean).join('\n'); // prettier-ignore
    const title = placement?.newSection ?? term.term.charAt(0).toUpperCase() + term.term.slice(1);
    const brief = await this.prisma.contentBrief.create({
      data: {
        projectId,
        title: title.slice(0, 255),
        primaryKeyword: term.term.slice(0, 200),
        secondaryKeywords: related,
        searchIntent: question ? 'INFORMATIONAL' : commercial ? 'COMMERCIAL' : 'INFORMATIONAL',
        country: report.country ?? stringArray(project.targetCountries)[0] ?? 'US',
        language: report.language,
        targetUrl: placement?.pageUrl ?? term.pages[0]?.url ?? null,
        notes: notes.slice(0, 4000),
      },
    });
    let taskId: string | null = null;
    if (input.dueDate) {
      const task = await this.prisma.task.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          type: 'CONTENT',
          title: `Write content for “${term.term}”`.slice(0, 255),
          description: `Content brief “${brief.title}” (Content → Briefs), planned from Keyword trends.`,
          status: 'TODO',
          priority: term.rising ? 'HIGH' : 'MEDIUM',
          dueDate: input.dueDate,
          entityType: 'ContentBrief',
          entityId: brief.id,
          createdById: user.id,
        },
      });
      taskId = task.id;
    }
    return { briefId: brief.id, taskId };
  }

  /** Saves one placement suggestion as a recommendation. */
  async savePlacement(user: AuthUser, projectId: string, reportId: string, term: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'recommendation.update');
    const report = await this.prisma.trendReport.findFirst({ where: { id: reportId, projectId } });
    const analysis = report?.analysis as unknown as TrendAnalysisResult | null | undefined;
    if (!report || !analysis) throw Errors.notFound('Trends report');
    const placement = analysis.placements.find((p) => p.term.toLowerCase() === term.trim().toLowerCase());
    if (!placement) throw Errors.notFound('Suggestion');
    const saved = await saveTrendPlacementAsRecommendation(
      this.prisma,
      projectId,
      reportId,
      placement,
      analysis.terms.find((t) => t.term === placement.term),
    );
    return { created: saved.created, recommendationId: saved.id };
  }

  // ---------------- Saved comparisons ----------------

  async listSaved(user: AuthUser, projectId: string): Promise<TrendSavedQueryDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.trendSavedQuery.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.savedDto(r));
  }

  async createSaved(
    user: AuthUser,
    projectId: string,
    input: TrendSavedQueryInput & { schedule: TrendSchedule },
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    if ((await this.prisma.trendSavedQuery.count({ where: { projectId } })) >= SAVED_QUERIES_PER_PROJECT)
      throw Errors.badRequest(
        `A project can save ${SAVED_QUERIES_PER_PROJECT} comparisons; delete one first.`,
      );
    if (input.provider && !isTrendSourceEnabled(input.provider))
      throw Errors.badRequest(`${TREND_SOURCE_LABELS[input.provider]} is turned off on this server.`);
    try {
      const row = await this.prisma.trendSavedQuery.create({
        data: {
          projectId,
          name: input.name,
          keywords: input.keywords,
          country: input.country ?? null,
          region: input.region ?? null,
          city: input.city ?? null,
          timeRange: input.timeRange ?? 'past_90_days',
          category: input.category ?? 0,
          provider: input.provider ?? null,
          schedule: input.schedule,
          nextRunAt: nextTrendRun(input.schedule, new Date()),
          createdById: user.id,
        },
      });
      return this.savedDto(row);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw Errors.conflict(`A saved comparison named "${input.name}" already exists.`);
      throw error;
    }
  }

  async updateSaved(
    user: AuthUser,
    projectId: string,
    savedId: string,
    input: { name?: string; schedule?: TrendSchedule },
  ) {
    // prettier-ignore
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const row = await this.prisma.trendSavedQuery.findFirst({ where: { id: savedId, projectId } });
    if (!row) throw Errors.notFound('Saved comparison');
    const updated = await this.prisma.trendSavedQuery.update({
      where: { id: savedId },
      data: {
        name: input.name,
        ...(input.schedule && input.schedule !== row.schedule
          ? { schedule: input.schedule, nextRunAt: nextTrendRun(input.schedule, new Date()) }
          : {}),
      },
    });
    return this.savedDto(updated);
  }

  async deleteSaved(user: AuthUser, projectId: string, savedId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const result = await this.prisma.trendSavedQuery.deleteMany({ where: { id: savedId, projectId } });
    if (!result.count) throw Errors.notFound('Saved comparison');
  }

  async runSaved(user: AuthUser, projectId: string, savedId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'keyword.manage');
    const row = await this.prisma.trendSavedQuery.findFirst({ where: { id: savedId, projectId } });
    if (!row) throw Errors.notFound('Saved comparison');
    return this.fetchLive(
      user,
      projectId,
      {
        keywords: stringArray(row.keywords),
        country: row.country,
        region: row.region,
        city: row.city,
        timeRange: row.timeRange as TrendTimeRange,
        category: row.category,
        provider: (row.provider as TrendLiveSource | null) ?? undefined,
        include: ['interest', 'regions', 'related_queries', 'related_topics'],
        suggestPlacements: true,
      },
      row.id,
    );
  }

  private savedDto(r: {
    id: string;
    name: string;
    keywords: unknown;
    country: string | null;
    region: string | null;
    city: string | null;
    timeRange: string;
    category: number;
    provider: string | null;
    schedule: string;
    nextRunAt: Date | null;
    lastReportId: string | null;
    createdAt: Date;
  }): TrendSavedQueryDto {
    return {
      id: r.id,
      name: r.name,
      keywords: stringArray(r.keywords),
      country: r.country,
      region: r.region,
      city: r.city,
      timeRange: r.timeRange as TrendTimeRange,
      category: r.category,
      provider: r.provider as TrendLiveSource | null,
      schedule: r.schedule as TrendSchedule,
      nextRunAt: iso(r.nextRunAt),
      lastReportId: r.lastReportId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  // ---------------- DTOs ----------------

  private summary(r: TrendReport): TrendReportSummaryDto {
    return {
      id: r.id,
      status: r.status,
      source: sourceOf(r.source),
      keywords: stringArray(r.keywords),
      country: r.country,
      region: r.region,
      city: r.city,
      timeRange: r.timeRange as TrendTimeRange,
      category: r.category,
      trigger: r.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL',
      cached: Boolean(r.cachedFromId),
      partial: r.partial,
      fetchedAt: iso(r.fetchedAt),
      createdAt: r.createdAt.toISOString(),
      finishedAt: iso(r.finishedAt),
    };
  }

  private async toDto(r: TrendReport): Promise<TrendReportDto> {
    const [job, data, imports] = await Promise.all([
      this.prisma.backgroundJob.findFirst({
        where: { entityType: 'TrendReport', entityId: r.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
      loadTrendData(this.prisma, r),
      this.prisma.trendCsvImport.findMany({
        where: { reportId: r.id },
        select: { fileName: true, kind: true, rowCount: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const s = this.summary(r);
    const sourceType = trendSourceType(s.source);
    return {
      ...s,
      projectId: r.projectId,
      sourceLabel: TREND_SOURCE_LABELS[s.source],
      sourceType,
      experimental: getTrendsProvider(s.source).meta.experimental,
      language: r.language,
      include: (Array.isArray(r.include) ? r.include : ['interest', 'related_queries']) as TrendDataType[],
      exploreUrl: googleTrendsExploreUrl({ keywords: s.keywords, country: s.country, region: s.region, timeRange: s.timeRange, category: s.category }), // prettier-ignore
      data,
      analysis: (r.analysis as unknown as TrendAnalysisResult | null) ?? null,
      expiresAt: iso(r.expiresAt),
      freshness:
        sourceType === 'CSV'
          ? 'imported'
          : !r.fetchedAt
            ? null
            : r.expiresAt && r.expiresAt > new Date()
              ? 'fresh'
              : 'stale',
      limitations: unique([...stringArray(r.limitations), ...trendSourceLimitations(s.source, data, r)]),
      imports: imports.map((i) => ({ fileName: i.fileName, kind: i.kind, rows: i.rowCount })),
      savedQueryId: r.savedQueryId,
      errorMessage: r.errorMessage,
      jobId: job?.id ?? null,
    };
  }
}
