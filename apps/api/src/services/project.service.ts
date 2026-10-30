import { recordAuditLog } from '@surfaced/core/audit-log';
import { getWorkspacePlan } from '@surfaced/core/billing';
import { UnsafeTargetError, assertUrlPolicy } from '@surfaced/core/crawler';
import type { Prisma, PrismaClient, Project, ProjectCompetitor } from '@surfaced/core/db';
import { locationWriteData } from '@surfaced/core/local';
import { Errors } from '@surfaced/core/errors';
import { removeReportFiles } from '@surfaced/core/reports';
import { clampCrawlSettings, nextAuditDate } from '@surfaced/core/scheduling';
import {
  assertCountLimit,
  countLocationsForLimit,
  countProjectsForLimit,
  withWorkspaceLock,
} from '@surfaced/core/usage';
import {
  DEFAULT_CRAWL_SETTINGS,
  EMPTY_BUSINESS_PROFILE,
  businessProfileSchema,
  crawlSettingsSchema,
  normalizeWebsiteUrl,
  type CompetitorDto,
  type CompetitorInput,
  type CrawlSettings,
  type PlanLimits,
  type ProjectCreateData,
  type ProjectDto,
  type ProjectSummaryDto,
  type ProjectUpdateData,
} from '@surfaced/shared';
import { stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess, requireWorkspaceAccess } from './access';

export function normalizeKeyword(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Rejects websites the crawler would never be allowed to fetch (private IPs, internal names, odd ports). */
export function assertWebsiteAllowed(websiteUrl: string): void {
  try {
    assertUrlPolicy(new URL(websiteUrl));
  } catch (error) {
    if (error instanceof UnsafeTargetError) throw Errors.unsupportedTarget(error.message);
    throw error;
  }
}

/** Merges crawl settings with defaults and clamps them to the plan and the server's hard limit. */
export function effectiveCrawlSettings(
  current: Partial<CrawlSettings> | null | undefined,
  patch: Partial<CrawlSettings> | undefined,
  limits: PlanLimits,
): CrawlSettings {
  return clampCrawlSettings(current, limits, patch);
}

function readCrawlSettings(raw: unknown): CrawlSettings {
  const parsed = crawlSettingsSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_CRAWL_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

type ProjectWithRelations = Project & {
  competitors: ProjectCompetitor[];
  keywords: { phrase: string }[];
  auditRuns: { score: number | null; finishedAt: Date | null }[];
};

export function toCompetitorDto(c: ProjectCompetitor): CompetitorDto {
  return {
    id: c.id,
    name: c.name,
    domain: c.domain,
    aliases: stringArray(c.aliases),
    notes: c.notes,
    kind: c.kind === 'LOCAL' ? 'LOCAL' : 'WEBSITE',
    status: c.status === 'SUGGESTED' || c.status === 'DISMISSED' ? c.status : 'CONFIRMED',
    source: c.source === 'DISCOVERED' ? 'DISCOVERED' : 'MANUAL',
    locationId: c.locationId,
    placeId: c.placeId,
    category: c.category,
    address: c.address,
    latitude: c.latitude === null ? null : Number(c.latitude),
    longitude: c.longitude === null ? null : Number(c.longitude),
    rating: c.rating,
    reviewCount: c.reviewCount,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export function readBusinessProfile(raw: unknown) {
  const parsed = businessProfileSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : EMPTY_BUSINESS_PROFILE;
}

function toSummary(
  p: Project & { auditRuns: { score: number | null; finishedAt: Date | null }[] },
): ProjectSummaryDto {
  const latest = p.auditRuns[0];
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    websiteUrl: p.websiteUrl,
    domain: p.domain,
    industry: p.industry,
    isDemo: p.isDemo,
    createdAt: p.createdAt.toISOString(),
    latestScore: latest?.score ?? null,
    latestAuditAt: latest?.finishedAt?.toISOString() ?? null,
  };
}

function toProjectDto(p: ProjectWithRelations): ProjectDto {
  return {
    ...toSummary(p),
    description: p.description,
    targetCountries: stringArray(p.targetCountries),
    targetLanguages: stringArray(p.targetLanguages),
    brandVoice: p.brandVoice,
    brandAliases: stringArray(p.brandAliases),
    crawlSettings: readCrawlSettings(p.crawlSettings),
    auditSchedule: p.auditSchedule,
    nextAuditAt: p.nextAuditAt?.toISOString() ?? null,
    competitors: p.competitors.map(toCompetitorDto),
    primaryKeywords: p.keywords.map((k) => k.phrase),
    businessProfile: readBusinessProfile(p.businessProfile),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const latestAudit = {
  where: { status: 'SUCCEEDED' as const },
  orderBy: { finishedAt: 'desc' as const },
  take: 1,
  select: { score: true, finishedAt: true },
};

const detailInclude = {
  competitors: { where: { status: 'CONFIRMED' }, orderBy: { createdAt: 'asc' as const } },
  keywords: { where: { isPrimary: true }, orderBy: { createdAt: 'asc' as const }, select: { phrase: true } },
  auditRuns: latestAudit,
};

/** Next run time for a scheduled audit. */
export class ProjectService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  async list(user: AuthUser, workspaceId: string): Promise<ProjectSummaryDto[]> {
    await requireWorkspaceAccess(this.prisma, user, workspaceId, 'project.read');
    const projects = await this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { auditRuns: latestAudit },
    });
    return projects.map(toSummary);
  }

  async get(user: AuthUser, projectId: string): Promise<ProjectDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: detailInclude,
    });
    return toProjectDto(project);
  }

  async create(
    user: AuthUser,
    workspaceId: string,
    input: ProjectCreateData,
    ip: string,
  ): Promise<ProjectDto> {
    await requireWorkspaceAccess(this.prisma, user, workspaceId, 'project.create');
    // The website is optional: local businesses can be managed through their listings alone.
    if (input.websiteUrl) assertWebsiteAllowed(input.websiteUrl);
    const site = input.websiteUrl ? normalizeWebsiteUrl(input.websiteUrl) : null;
    const competitors = dedupeCompetitors(input.competitors ?? [], site?.domain ?? null);
    const locations = input.locations ?? [];

    const project = await withWorkspaceLock(this.prisma, workspaceId, async (tx) => {
      const count = await countProjectsForLimit(tx, workspaceId);
      const limits = await assertCountLimit(tx, workspaceId, 'projects', count);
      if (competitors.length > limits.competitorsPerProject) {
        throw Errors.planLimit(`Your plan allows ${limits.competitorsPerProject} competitors per project.`, {
          kind: 'competitorsPerProject',
          limit: limits.competitorsPerProject,
        });
      }
      if (site) {
        const exists = await tx.project.findFirst({ where: { workspaceId, domain: site.domain } });
        if (exists) throw Errors.conflict(`A project for ${site.domain} already exists in this workspace.`);
      }
      if (locations.length) {
        const used = await countLocationsForLimit(tx, workspaceId);
        await assertCountLimit(tx, workspaceId, 'businessLocations', used + locations.length - 1);
      }

      // Audits need a website; without one the schedule stays manual.
      const schedule = site ? (input.auditSchedule ?? 'MANUAL') : 'MANUAL';
      if (schedule !== 'MANUAL' && !limits.scheduledAudits)
        throw Errors.planLimit('Scheduled audits are not included in your plan.');
      const created = await tx.project.create({
        data: {
          workspaceId,
          name: input.name,
          description: input.description,
          websiteUrl: site?.url ?? null,
          domain: site?.domain ?? null,
          businessProfile: input.businessProfile ?? EMPTY_BUSINESS_PROFILE,
          industry: input.industry,
          targetCountries: input.targetCountries,
          targetLanguages: input.targetLanguages,
          brandVoice: input.brandVoice,
          brandAliases: input.brandAliases ?? [],
          crawlSettings: effectiveCrawlSettings(null, input.crawlSettings, limits),
          auditSchedule: schedule,
          nextAuditAt: nextAuditDate(schedule),
          createdById: user.id,
        },
      });
      if (competitors.length) {
        await tx.projectCompetitor.createMany({
          data: competitors.map((c) => ({
            projectId: created.id,
            name: c.name,
            domain: c.domain,
            aliases: c.aliases ?? [],
            notes: c.notes,
          })),
        });
      }
      if (locations.length)
        await tx.businessLocation.createMany({
          data: locations.map((l, i) => ({
            projectId: created.id,
            ...locationWriteData({ ...l, isPrimary: l.isPrimary || i === 0 }),
          })),
        });
      await this.writePrimaryKeywords(tx, created, input.primaryKeywords ?? []);
      return created;
    });

    await recordAuditLog(this.prisma, {
      action: 'project.created',
      actorUserId: user.id,
      workspaceId,
      targetType: 'Project',
      targetId: project.id,
      ipAddress: ip,
      metadata: { domain: project.domain, locations: locations.length },
    });
    return this.get(user, project.id);
  }

  private async writePrimaryKeywords(
    tx: Prisma.TransactionClient,
    project: Project,
    phrases: string[],
  ): Promise<void> {
    const country = stringArray(project.targetCountries)[0] ?? 'US';
    const language = stringArray(project.targetLanguages)[0] ?? 'en';
    const wanted = new Map(phrases.map((p) => [normalizeKeyword(p), p.trim()]));
    await tx.projectKeyword.updateMany({
      where: { projectId: project.id, isPrimary: true, normalizedPhrase: { notIn: [...wanted.keys()] } },
      data: { isPrimary: false },
    });
    for (const [normalizedPhrase, phrase] of wanted) {
      await tx.projectKeyword.upsert({
        where: {
          projectId_normalizedPhrase_country_language: {
            projectId: project.id,
            normalizedPhrase,
            country,
            language,
          },
        },
        update: { isPrimary: true },
        create: {
          projectId: project.id,
          phrase,
          normalizedPhrase,
          country,
          language,
          isPrimary: true,
          priority: 'HIGH',
          source: 'MANUAL',
        },
      });
    }
  }

  async update(user: AuthUser, projectId: string, input: ProjectUpdateData): Promise<ProjectDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.update');
    const { limits } = await getWorkspacePlan(this.prisma, project.workspaceId);
    const data: Prisma.ProjectUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.industry !== undefined) data.industry = input.industry;
    if (input.targetCountries) data.targetCountries = input.targetCountries;
    if (input.targetLanguages) data.targetLanguages = input.targetLanguages;
    if (input.brandVoice !== undefined) data.brandVoice = input.brandVoice;
    if (input.brandAliases) data.brandAliases = input.brandAliases;
    if (input.businessProfile) data.businessProfile = input.businessProfile;
    if (input.websiteUrl === null) {
      // Removing the website stops scheduled audits; their history is kept.
      data.websiteUrl = null;
      data.domain = null;
      data.auditSchedule = 'MANUAL';
      data.nextAuditAt = null;
    } else if (input.websiteUrl) {
      assertWebsiteAllowed(input.websiteUrl);
      const site = normalizeWebsiteUrl(input.websiteUrl);
      if (site.domain !== project.domain) {
        const clash = await this.prisma.project.findFirst({
          where: { workspaceId: project.workspaceId, domain: site.domain },
        });
        if (clash && clash.id !== project.id)
          throw Errors.conflict(`A project for ${site.domain} already exists in this workspace.`);
      }
      data.websiteUrl = site.url;
      data.domain = site.domain;
    }
    if (input.crawlSettings)
      data.crawlSettings = effectiveCrawlSettings(
        readCrawlSettings(project.crawlSettings),
        input.crawlSettings,
        limits,
      );
    if (input.auditSchedule && input.websiteUrl !== null) {
      if (input.auditSchedule !== 'MANUAL' && !project.websiteUrl && !input.websiteUrl)
        throw Errors.badRequest('Scheduled audits need a website.');
      if (input.auditSchedule !== 'MANUAL' && !limits.scheduledAudits)
        throw Errors.planLimit('Scheduled audits are not included in your plan.');
      data.auditSchedule = input.auditSchedule;
      data.nextAuditAt = nextAuditDate(input.auditSchedule);
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({ where: { id: projectId }, data });
      if (input.primaryKeywords) await this.writePrimaryKeywords(tx, updated, input.primaryKeywords);
    });
    await recordAuditLog(this.prisma, {
      action: 'project.updated',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'Project',
      targetId: projectId,
      metadata: { fields: Object.keys(input) },
    });
    return this.get(user, projectId);
  }

  async remove(user: AuthUser, projectId: string, ip: string): Promise<void> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.delete');
    await recordAuditLog(this.prisma, {
      action: 'project.deleted',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'Project',
      targetId: projectId,
      ipAddress: ip,
      metadata: { domain: project.domain, name: project.name },
    });
    // Report rows cascade with the project; their files in storage do not.
    await removeReportFiles(this.prisma, { projectId });
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  async history(user: AuthUser, projectId: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const take = 25;
    const [crawls, runs, reports, documents, logs] = await Promise.all([
      this.prisma.crawlJob.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          auditRuns: { select: { id: true, score: true }, take: 1, orderBy: { createdAt: 'desc' } },
        },
      }),
      this.prisma.aiVisibilityRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.report.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.contentDocument.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' }, take }),
      this.prisma.auditLog.findMany({
        where: { workspaceId: project.workspaceId, targetType: 'Project', targetId: projectId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { actor: { select: { name: true } } },
      }),
    ]);
    const base = `/app/p/${projectId}`;
    const events = [
      ...crawls.map((c) => ({
        type: 'audit',
        title: `Website audit ${c.status.toLowerCase()}${c.auditRuns[0]?.score != null ? ` · score ${c.auditRuns[0].score}` : ''}`,
        detail: `${c.pagesCrawled} pages crawled`,
        at: c.createdAt.toISOString(),
        link: c.auditRuns[0] ? `${base}/audits/${c.auditRuns[0].id}` : `${base}/audits`,
      })),
      ...runs.map((r) => ({
        type: 'visibility',
        title: `AI visibility run ${r.status.toLowerCase()}`,
        detail: `${r.successCount}/${r.observationCount} observations succeeded`,
        at: r.createdAt.toISOString(),
        link: `${base}/visibility`,
      })),
      ...reports.map((r) => ({
        type: 'report',
        title: `Report: ${r.title}`,
        detail: r.status.toLowerCase(),
        at: r.createdAt.toISOString(),
        link: `${base}/reports/${r.id}`,
      })),
      ...documents.map((d) => ({
        type: 'content',
        title: `Content: ${d.title}`,
        detail: d.status.toLowerCase().replace('_', ' '),
        at: d.updatedAt.toISOString(),
        link: `${base}/content/${d.id}`,
      })),
      ...logs.map((l) => ({
        type: 'settings',
        title: l.action.replace('project.', 'Project ').replace('_', ' '),
        detail: l.actor ? `by ${l.actor.name}` : '',
        at: l.createdAt.toISOString(),
        link: `${base}/settings`,
      })),
    ];
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  }

  // ---------------- Competitors ----------------

  async listCompetitors(user: AuthUser, projectId: string): Promise<CompetitorDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.projectCompetitor.findMany({
      where: { projectId, status: 'CONFIRMED' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toCompetitorDto);
  }

  async addCompetitor(user: AuthUser, projectId: string, input: CompetitorInput): Promise<CompetitorDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'competitor.manage');
    if (input.domain === project.domain) throw Errors.badRequest('A competitor cannot use your own domain.');
    const count = await this.prisma.projectCompetitor.count({ where: { projectId, status: 'CONFIRMED' } });
    await assertCountLimit(this.prisma, project.workspaceId, 'competitorsPerProject', count);
    const exists = await this.prisma.projectCompetitor.findUnique({
      where: { projectId_domain: { projectId, domain: input.domain } },
    });
    if (exists) throw Errors.conflict(`${input.domain} is already a competitor in this project.`);
    const created = await this.prisma.projectCompetitor.create({
      data: {
        projectId,
        name: input.name,
        domain: input.domain,
        aliases: input.aliases ?? [],
        notes: input.notes,
      },
    });
    return toCompetitorDto(created);
  }

  async updateCompetitor(
    user: AuthUser,
    projectId: string,
    competitorId: string,
    input: Partial<CompetitorInput>,
  ): Promise<CompetitorDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'competitor.manage');
    const competitor = await this.prisma.projectCompetitor.findFirst({
      where: { id: competitorId, projectId },
    });
    if (!competitor) throw Errors.notFound('Competitor');
    if (input.domain && input.domain === project.domain)
      throw Errors.badRequest('A competitor cannot use your own domain.');
    const updated = await this.prisma.projectCompetitor.update({
      where: { id: competitorId },
      data: { name: input.name, domain: input.domain, aliases: input.aliases, notes: input.notes },
    });
    return toCompetitorDto(updated);
  }

  async removeCompetitor(user: AuthUser, projectId: string, competitorId: string): Promise<void> {
    await requireProjectAccess(this.prisma, user, projectId, 'competitor.manage');
    const result = await this.prisma.projectCompetitor.deleteMany({ where: { id: competitorId, projectId } });
    if (result.count === 0) throw Errors.notFound('Competitor');
  }
}

function dedupeCompetitors(list: CompetitorInput[], ownDomain: string | null): CompetitorInput[] {
  const seen = new Set<string>();
  const out: CompetitorInput[] = [];
  for (const c of list) {
    if (ownDomain && c.domain === ownDomain)
      throw Errors.badRequest(`Competitor ${c.domain} is the project's own domain.`);
    if (seen.has(c.domain)) continue;
    seen.add(c.domain);
    out.push(c);
  }
  return out;
}
