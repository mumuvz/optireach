import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, DEFAULT_SCORING_CONFIG } from '@surfaced/shared';
import {
  analyzeSite,
  dbPageToAnalysis,
  executeAuditJob,
  executeCrawlJob,
  loadAnalysisInput,
  pageRecordToCreateData,
  persistProjectAudit,
  type AnalysisInput,
  type AnalysisPage,
} from '../src/audit';
import { ensureDefaultPlans } from '../src/billing';
import { crawlSite, type CrawledPageRecord } from '../src/crawler';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { JobTracker, createJobRecord } from '../src/jobs';
import { MemoryQueueGateway, type AuditJobData } from '../src/queue';
import { startFixtureSite, type FixtureSite } from './fixtures/fixture-site';

const ALLOW = ['127.0.0.1:*'];
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
  await disconnectPrisma();
});

function toAnalysisPage(record: CrawledPageRecord, index: number): AnalysisPage {
  const data = pageRecordToCreateData('crawl', record);
  return dbPageToAnalysis(
    { id: `p${index}`, ...data } as unknown as Parameters<typeof dbPageToAnalysis>[0],
    record.internalLinks,
  );
}

async function analyzeFixture(): Promise<{ input: AnalysisInput; result: ReturnType<typeof analyzeSite> }> {
  const records: CrawledPageRecord[] = [];
  const summary = await crawlSite(
    {
      startUrl: `${site.origin}/`,
      maxPages: 50,
      maxDepth: 5,
      includeSubdomains: false,
      crawlDelayMs: 0,
      concurrency: 2,
      fetcherOptions: { allowlist: ALLOW },
    },
    { onPage: async (r) => void records.push(r) },
  );
  const input: AnalysisInput = { pages: records.map(toAnalysisPage), crawl: summary };
  return { input, result: analyzeSite(input) };
}

describe('audit rule engine', () => {
  let analysis: Awaited<ReturnType<typeof analyzeFixture>>;
  beforeAll(async () => {
    analysis = await analyzeFixture();
  });
  const has = (ruleId: string, path?: string) =>
    analysis.result.issues.some(
      (i) =>
        i.ruleId === ruleId && (path === undefined || (i.url !== null && new URL(i.url).pathname === path)),
    );

  it('detects missing titles and metadata problems', () => {
    expect(has('title-missing', '/no-title')).toBe(true);
    expect(has('meta-description-missing', '/about')).toBe(true);
    expect(has('title-missing', '/')).toBe(false);
  });

  it('detects duplicate titles across pages with evidence', () => {
    const dupes = analysis.result.issues.filter((i) => i.ruleId === 'title-duplicate');
    expect(dupes.map((i) => new URL(i.url!).pathname).sort()).toEqual(['/about', '/products']);
    expect(dupes[0]!.evidence.otherUrls).toHaveLength(1);
  });

  it('detects HTTP errors, broken internal links and redirects', () => {
    expect(has('http-4xx', '/broken')).toBe(true);
    const broken = analysis.result.issues.find(
      (i) => i.ruleId === 'broken-internal-link' && new URL(i.url!).pathname === '/',
    );
    expect(broken?.evidence.brokenLinks).toEqual([{ url: `${site.origin}/broken`, status: 404 }]);
    expect(has('redirect-chain', '/redirect-old')).toBe(true);
    expect(has('internal-link-to-redirect', '/')).toBe(true);
    expect(has('sitemap-non-indexable-url', '/broken')).toBe(true);
  });

  it('detects structure, structured data, image and linking issues', () => {
    expect(has('h1-missing', '/about')).toBe(true);
    expect(has('h1-multiple', '/products/item-1')).toBe(true);
    expect(has('heading-level-skipped', '/products/item-1')).toBe(true);
    expect(has('jsonld-parse-error', '/products/item-1')).toBe(true);
    expect(has('img-missing-alt', '/')).toBe(true);
    expect(has('generic-anchor-text', '/')).toBe(true);
    expect(has('orphan-page', '/orphan')).toBe(true);
    expect(has('orphan-page', '/about')).toBe(false);
    const blocked = analysis.result.issues.find((i) => i.ruleId === 'blocked-by-robots');
    expect(blocked?.url).toBe(`${site.origin}/private/secret`);
    expect(blocked?.evidence.foundOn).toEqual([`${site.origin}/`]);
  });

  it('reports site-level findings and limitations', () => {
    expect(has('http-not-https')).toBe(true); // the fixture is served over plain HTTP
    expect(has('sitemap-missing')).toBe(false);
    expect(has('organization-schema-missing')).toBe(false);
    expect(analysis.result.limitations.join(' ')).toMatch(/robots\.txt disallows/);
  });

  it('is deterministic and produces a bounded score', () => {
    const again = analyzeSite(analysis.input);
    expect(again.issues.map((i) => i.fingerprint)).toEqual(analysis.result.issues.map((i) => i.fingerprint));
    expect(again.score).toEqual(analysis.result.score);
    expect(analysis.result.score.score).toBeGreaterThanOrEqual(0);
    expect(analysis.result.score.score).toBeLessThan(100);
    expect(analysis.result.issueCounts.total).toBe(analysis.result.issues.length);
  });
});

describe('crawl → audit pipeline (MySQL)', () => {
  const prisma = getPrisma();

  async function setupProject() {
    await ensureDefaultPlans(prisma);
    const user = await prisma.user.create({
      data: { email: `audit-${randomToken(6)}@example.test`, name: 'Audit Owner', passwordHash: 'x' },
    });
    const workspace = await prisma.workspace.create({
      data: { name: 'Audit WS', slug: `audit-${randomToken(6).toLowerCase()}` },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Fixture Outdoor',
        websiteUrl: `${site.origin}/`,
        domain: `fixture-${randomToken(4).toLowerCase()}.test`,
        targetCountries: ['US'],
        targetLanguages: ['en'],
        crawlSettings: DEFAULT_CRAWL_SETTINGS,
      },
    });
    return { user, workspace, project };
  }

  async function runAudit(projectId: string, workspaceId: string) {
    const queues = new MemoryQueueGateway();
    const crawl = await prisma.crawlJob.create({
      data: { projectId, startUrl: `${site.origin}/`, settings: DEFAULT_CRAWL_SETTINGS },
    });
    const run = await prisma.auditRun.create({
      data: {
        projectId,
        crawlJobId: crawl.id,
        scoringVersion: DEFAULT_SCORING_CONFIG.version,
        weights: DEFAULT_SCORING_CONFIG as never,
      },
    });
    const crawlJob = await createJobRecord(prisma, {
      type: 'CRAWL',
      queue: 'crawl',
      workspaceId,
      projectId,
      entityType: 'CrawlJob',
      entityId: crawl.id,
    });
    const crawlTracker = new JobTracker(prisma, crawlJob.id, 0);
    await crawlTracker.start(1);
    const outcome = await executeCrawlJob(
      { prisma, queues, fetcherOptions: { allowlist: ALLOW } },
      crawl.id,
      crawlTracker,
    );
    await crawlTracker.succeed();
    const queued = queues.drain('audit');
    expect(queued).toHaveLength(1);
    const data = queued[0]!.data as AuditJobData;
    expect(data).toMatchObject({ crawlJobId: crawl.id, auditRunId: run.id });
    const auditTracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await auditTracker.start(1);
    const audit = await executeAuditJob({ prisma, queues }, data, auditTracker);
    return { crawl, run, outcome, audit, queues };
  }

  it('persists pages, links, a scored audit run, issues, recommendations and notifications', async () => {
    const { workspace, project, user } = await setupProject();
    const { crawl, run, outcome, audit } = await runAudit(project.id, workspace.id);
    expect(outcome.status).toBe('completed');

    const storedCrawl = await prisma.crawlJob.findUniqueOrThrow({ where: { id: crawl.id } });
    expect(storedCrawl).toMatchObject({ status: 'SUCCEEDED', pagesCrawled: outcome.pagesCrawled });
    expect(await prisma.crawledPage.count({ where: { crawlJobId: crawl.id } })).toBe(outcome.pagesCrawled);
    expect(await prisma.crawledLink.count({ where: { crawlJobId: crawl.id } })).toBeGreaterThan(5);
    const home = await prisma.crawledPage.findFirstOrThrow({
      where: { crawlJobId: crawl.id, url: `${site.origin}/` },
    });
    expect(home.isIndexable).toBe(true);
    // Inlinks count distinct linking pages: only the home page links to /about (directly and via a redirect).
    const about = await prisma.crawledPage.findFirstOrThrow({
      where: { crawlJobId: crawl.id, url: `${site.origin}/about` },
    });
    expect(about.inlinksCount).toBe(1);
    const orphan = await prisma.crawledPage.findFirstOrThrow({
      where: { crawlJobId: crawl.id, url: `${site.origin}/orphan` },
    });
    expect(orphan.inlinksCount).toBe(0);
    expect(home.inlinksCount).toBeGreaterThanOrEqual(4);

    const storedRun = await prisma.auditRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(storedRun.status).toBe('SUCCEEDED');
    expect(storedRun.score).toBe(audit.score);
    const issues = await prisma.auditIssue.findMany({ where: { projectId: project.id } });
    expect(issues).toHaveLength(audit.issues);
    expect(await prisma.auditIssueOccurrence.count({ where: { auditRunId: run.id } })).toBe(audit.issues);
    const missingTitle = issues.find((i) => i.ruleId === 'title-missing');
    expect(missingTitle).toMatchObject({ status: 'OPEN', url: `${site.origin}/no-title`, severity: 'HIGH' });

    const recs = await prisma.recommendation.findMany({ where: { projectId: project.id } });
    expect(recs.length).toBeGreaterThan(5);
    expect(recs.every((r) => r.expectedBenefit.includes('not guaranteed'))).toBe(true);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'audit.completed' } })).toBe(1);
  });

  it('keeps issue identity across audits and resolves fixed issues only on re-crawled pages', async () => {
    const { workspace, project } = await setupProject();
    const first = await runAudit(project.id, workspace.id);
    const before = await prisma.auditIssue.findMany({ where: { projectId: project.id } });

    const second = await runAudit(project.id, workspace.id);
    const after = await prisma.auditIssue.findMany({ where: { projectId: project.id } });
    expect(after).toHaveLength(before.length); // no duplicates
    const firstMissing = before.find((i) => i.ruleId === 'title-missing')!;
    const secondMissing = after.find((i) => i.id === firstMissing.id)!;
    expect(secondMissing.firstDetectedAt.getTime()).toBe(firstMissing.firstDetectedAt.getTime());
    expect(secondMissing.lastAuditRunId).toBe(second.run.id);
    expect(secondMissing.firstAuditRunId).toBe(first.run.id);

    // Simulate the site owner fixing the missing title, then re-score the stored crawl.
    const input = await loadAnalysisInput(prisma, second.crawl.id);
    const fixedPage = input.pages.find((p) => p.url.endsWith('/no-title'))!;
    fixedPage.title = 'A descriptive page title';
    const rescored = analyzeSite(input);
    const run3 = await prisma.auditRun.create({
      data: {
        projectId: project.id,
        crawlJobId: second.crawl.id,
        scoringVersion: DEFAULT_SCORING_CONFIG.version,
        weights: DEFAULT_SCORING_CONFIG as never,
      },
    });
    const outcome = await persistProjectAudit(prisma, {
      projectId: project.id,
      auditRunId: run3.id,
      result: rescored,
      input,
    });
    expect(outcome.resolvedIssues).toBeGreaterThanOrEqual(1);
    const resolved = await prisma.auditIssue.findUniqueOrThrow({ where: { id: firstMissing.id } });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedAt).not.toBeNull();
  });
});
