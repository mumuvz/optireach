import {
  DEFAULT_CRAWL_SETTINGS,
  combinePageCaps,
  DEFAULT_PLANS,
  DEFAULT_SCORING_CONFIG,
  usagePeriodKey,
  type PromptFrequency,
} from '@surfaced/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDefaultPlans } from '../src/billing';
import { decryptSecret, randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { getEnv } from '../src/env';
import { getLogger } from '../src/logger';
import { MemoryQueueGateway } from '../src/queue';
import {
  clampCrawlSettings,
  queueIntegrationSyncs,
  runScheduledAudits,
  runScheduledVisibility,
  sendWeeklySummaries,
} from '../src/scheduling';

const prisma = getPrisma();
const logger = getLogger('scheduling-test');
const DAY = 24 * 3600 * 1000;

beforeAll(async () => {
  await ensureDefaultPlans(prisma);
});
afterAll(async () => {
  await disconnectPrisma();
});

function deps() {
  const queues = new MemoryQueueGateway();
  return { queues, deps: { prisma, queues, logger } };
}

async function workspaceOn(planKey: 'FREE' | 'GROWTH', userData: { weeklySummary?: boolean } = {}) {
  const owner = await prisma.user.create({
    data: {
      email: `sched-${randomToken(8)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}@example.test`,
      name: 'Sched Owner',
      passwordHash: 'x',
      emailVerifiedAt: new Date(),
      notificationPrefs: userData.weeklySummary === false ? { weeklySummary: false } : undefined,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Sched WS',
      slug: `sched-${randomToken(8)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}`,
      members: { create: { userId: owner.id, role: 'OWNER' } },
    },
  });
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: planKey } });
  await prisma.subscription.create({
    data: { workspaceId: workspace.id, planId: plan.id, status: 'ACTIVE', provider: 'DEV' },
  });
  return { owner, workspace };
}

function createProject(
  workspaceId: string,
  data: { auditSchedule?: 'WEEKLY' | 'MONTHLY'; nextAuditAt?: Date } = {},
) {
  const domain = `sched-${randomToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}.example.com`;
  return prisma.project.create({
    data: {
      workspaceId,
      name: 'Sched Site',
      websiteUrl: `https://${domain}/`,
      domain,
      targetCountries: ['US'],
      targetLanguages: ['en'],
      crawlSettings: { ...DEFAULT_CRAWL_SETTINGS, maxPages: 5000 },
      ...data,
    },
  });
}

function createPrompt(
  projectId: string,
  frequency: PromptFrequency,
  nextRunAt: Date | null,
  providers = ['mock_demo'],
) {
  return prisma.aiPrompt.create({
    data: {
      projectId,
      text: `best tools ${randomToken(4)}`,
      country: 'US',
      language: 'en',
      targetBrand: 'Sched',
      providers,
      frequency,
      nextRunAt,
    },
  });
}

describe('crawl caps', () => {
  it('crawls every page unless the project, the plan or the server sets a cap', () => {
    expect(combinePageCaps(null, undefined, 0)).toBeNull();
    expect(combinePageCaps(100, null, 0)).toBe(100);
    expect(combinePageCaps(100, 50, 0)).toBe(50);
    expect(combinePageCaps(null, 50, 20)).toBe(20);

    const server = getEnv().CRAWLER_MAX_PAGES_HARD_LIMIT;
    const free = DEFAULT_PLANS.find((p) => p.key === 'FREE')!.limits;
    expect(clampCrawlSettings({}, free)).toMatchObject({
      maxPages: combinePageCaps(null, null, server),
      maxDepth: null,
    });
    // A page cap a platform admin sets on a plan still applies, including to "crawl every page".
    const capped = { ...free, pagesPerAudit: 50 };
    expect(clampCrawlSettings({ maxPages: null }, capped).maxPages).toBe(combinePageCaps(50, server));
    expect(clampCrawlSettings({ maxPages: 5000, maxDepth: 3 }, capped)).toMatchObject({
      maxPages: combinePageCaps(5000, 50, server),
      maxDepth: 3,
    });
    expect(clampCrawlSettings({ maxPages: 20 }, capped).maxPages).toBe(combinePageCaps(20, server));
  });
});

describe('scheduled audits', () => {
  it('starts due audits once, clamps settings to the plan, and records usage', async () => {
    const { workspace } = await workspaceOn('GROWTH');
    const due = new Date(Date.now() - 60_000);
    const project = await createProject(workspace.id, { auditSchedule: 'WEEKLY', nextAuditAt: due });
    const { queues, deps: d } = deps();
    const now = new Date();

    const first = await runScheduledAudits({ ...d, now: () => now });
    expect(first.skipped.find((s) => s.id === project.id)).toBeUndefined();
    const crawl = await prisma.crawlJob.findFirstOrThrow({ where: { projectId: project.id } });
    expect(crawl).toMatchObject({ trigger: 'SCHEDULED', createdById: null });
    const growthCap = DEFAULT_PLANS.find((p) => p.key === 'GROWTH')!.limits.pagesPerAudit;
    // The project asks for 5,000 pages; plan and server caps apply only when set (null/0 = no cap).
    expect((crawl.settings as { maxPages: number | null }).maxPages).toBe(
      combinePageCaps(5000, growthCap, getEnv().CRAWLER_MAX_PAGES_HARD_LIMIT),
    );
    expect(await prisma.auditRun.count({ where: { crawlJobId: crawl.id } })).toBe(1);
    expect(await prisma.usageRecord.count({ where: { idempotencyKey: `audit:${crawl.id}` } })).toBe(1);
    expect(
      queues.jobs.filter(
        (j) => j.queue === 'crawl' && (j.data as { crawlJobId: string }).crawlJobId === crawl.id,
      ),
    ).toHaveLength(1);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.nextAuditAt!.getTime()).toBe(now.getTime() + 7 * DAY);

    // A second tick at the same time finds nothing due for this project.
    await runScheduledAudits({ ...d, now: () => now });
    expect(await prisma.crawlJob.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('skips and notifies when the plan no longer includes scheduled audits or the quota is used up', async () => {
    const free = await workspaceOn('FREE');
    const downgraded = await createProject(free.workspace.id, {
      auditSchedule: 'WEEKLY',
      nextAuditAt: new Date(Date.now() - 60_000),
    });
    const growth = await workspaceOn('GROWTH');
    const exhausted = await createProject(growth.workspace.id, {
      auditSchedule: 'MONTHLY',
      nextAuditAt: new Date(Date.now() - 60_000),
    });
    await prisma.usageRecord.create({
      data: {
        workspaceId: growth.workspace.id,
        metric: 'AUDIT_RUN',
        quantity: 60,
        periodKey: usagePeriodKey(),
        idempotencyKey: `test-quota:${randomToken(8)}`,
      },
    });
    const { deps: d } = deps();
    const result = await runScheduledAudits(d);

    expect(result.skipped.find((s) => s.id === downgraded.id)?.reason).toMatch(
      /does not include scheduled audits/,
    );
    expect(result.skipped.find((s) => s.id === exhausted.id)?.reason).toMatch(/includes 60 audits/);
    expect(await prisma.crawlJob.count({ where: { projectId: { in: [downgraded.id, exhausted.id] } } })).toBe(
      0,
    );
    const notice = await prisma.notification.findFirst({
      where: { userId: free.owner.id, type: 'scheduled_audit_skipped' },
    });
    expect(notice?.link).toBe(`/app/p/${downgraded.id}/audits`);
    // Skipped items wait for the next period instead of retrying every tick.
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: downgraded.id } })).nextAuditAt!.getTime(),
    ).toBeGreaterThan(Date.now());
  });
});

describe('scheduled visibility checks', () => {
  it('queues one run per project for due prompts the plan allows, with configured providers only', async () => {
    const { workspace } = await workspaceOn('GROWTH');
    const project = await createProject(workspace.id);
    const past = new Date(Date.now() - 60_000);
    const daily = await createPrompt(project.id, 'DAILY', past);
    const weekly = await createPrompt(project.id, 'WEEKLY', past);
    const manual = await createPrompt(project.id, 'MANUAL', null);
    const unconfigured = await createPrompt(project.id, 'WEEKLY', past, ['openai_web_search']);
    const { queues, deps: d } = deps();
    const now = new Date();

    const result = await runScheduledVisibility({ ...d, now: () => now });
    const run = await prisma.aiVisibilityRun.findFirstOrThrow({ where: { projectId: project.id } });
    expect(run).toMatchObject({ trigger: 'SCHEDULED', promptCount: 2 });
    const job = await prisma.backgroundJob.findFirstOrThrow({ where: { entityId: run.id } });
    const payload = job.payload as { promptIds: string[]; plannedChecks: number };
    expect(payload.promptIds.sort()).toEqual([daily.id, weekly.id].sort());
    expect(payload.plannedChecks).toBe(2);
    expect(queues.jobs.some((j) => j.queue === 'visibility' && j.jobId === job.id)).toBe(true);
    expect(result.skipped.find((s) => s.id === project.id)?.reason).toMatch(/not configured/);

    const prompts = await prisma.aiPrompt.findMany({ where: { projectId: project.id } });
    const byId = new Map(prompts.map((p) => [p.id, p]));
    expect(byId.get(daily.id)!.nextRunAt!.getTime()).toBe(now.getTime() + DAY);
    expect(byId.get(weekly.id)!.nextRunAt!.getTime()).toBe(now.getTime() + 7 * DAY);
    expect(byId.get(manual.id)!.nextRunAt).toBeNull();
    expect(byId.get(unconfigured.id)!.nextRunAt!.getTime()).toBe(now.getTime() + 7 * DAY);
  });

  it('leaves prompts due while a run is active and skips frequencies the plan does not allow', async () => {
    const growth = await workspaceOn('GROWTH');
    const busy = await createProject(growth.workspace.id);
    const past = new Date(Date.now() - 60_000);
    const waiting = await createPrompt(busy.id, 'WEEKLY', past);
    await prisma.aiVisibilityRun.create({ data: { projectId: busy.id, status: 'RUNNING' } });

    const free = await workspaceOn('FREE');
    const freeProject = await createProject(free.workspace.id);
    const daily = await createPrompt(freeProject.id, 'DAILY', past);
    const { deps: d } = deps();

    const result = await runScheduledVisibility(d);
    expect((await prisma.aiPrompt.findUniqueOrThrow({ where: { id: waiting.id } })).nextRunAt).toEqual(past);
    expect(result.skipped.find((s) => s.id === freeProject.id)?.reason).toMatch(
      /does not include daily checks/,
    );
    expect(await prisma.aiVisibilityRun.count({ where: { projectId: freeProject.id } })).toBe(0);
    expect(
      (await prisma.aiPrompt.findUniqueOrThrow({ where: { id: daily.id } })).nextRunAt!.getTime(),
    ).toBeGreaterThan(Date.now());
  });
});

describe('daily Search Console sync', () => {
  it('queues connected properties once and ignores integrations without a property', async () => {
    const { owner, workspace } = await workspaceOn('GROWTH');
    const project = await createProject(workspace.id);
    const other = await createProject(workspace.id);
    const ready = await prisma.integration.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        provider: 'GOOGLE_SEARCH_CONSOLE',
        status: 'CONNECTED',
        config: { siteUrl: 'sc-domain:sched.example.com' },
        connectedById: owner.id,
      },
    });
    const noProperty = await prisma.integration.create({
      data: {
        workspaceId: workspace.id,
        projectId: other.id,
        provider: 'GOOGLE_SEARCH_CONSOLE',
        status: 'CONNECTED',
        connectedById: owner.id,
      },
    });
    const { queues, deps: d } = deps();
    await queueIntegrationSyncs(d);
    await queueIntegrationSyncs(d);
    const jobs = await prisma.backgroundJob.findMany({
      where: { type: 'INTEGRATION_SYNC', entityId: { in: [ready.id, noProperty.id] } },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.entityId).toBe(ready.id);
    expect(queues.jobs.filter((j) => j.queue === 'integration-sync' && j.jobId === jobs[0]!.id)).toHaveLength(
      1,
    );
  });
});

describe('weekly summary', () => {
  it('summarizes recorded data only, once per week, for opted-in users', async () => {
    const { owner, workspace } = await workspaceOn('GROWTH');
    const optedOut = await workspaceOn('GROWTH', { weeklySummary: false });
    const project = await createProject(workspace.id);
    await createProject(optedOut.workspace.id);
    const now = new Date();
    for (const [score, finishedAt] of [
      [70, new Date(now.getTime() - 10 * DAY)],
      [80, new Date(now.getTime() - DAY)],
    ] as const) {
      const crawl = await prisma.crawlJob.create({
        data: {
          projectId: project.id,
          startUrl: project.websiteUrl!,
          settings: DEFAULT_CRAWL_SETTINGS,
          status: 'SUCCEEDED',
        },
      });
      await prisma.auditRun.create({
        data: {
          projectId: project.id,
          crawlJobId: crawl.id,
          scoringVersion: DEFAULT_SCORING_CONFIG.version,
          weights: DEFAULT_SCORING_CONFIG as never,
          status: 'SUCCEEDED',
          score,
          finishedAt,
        },
      });
    }
    const prompt = await createPrompt(project.id, 'WEEKLY', null);
    const run = await prisma.aiVisibilityRun.create({ data: { projectId: project.id, status: 'SUCCEEDED' } });
    for (const [i, mentioned, cited] of [
      [0, true, true],
      [1, true, false],
      [2, false, false],
    ] as const) {
      await prisma.aiVisibilityObservation.create({
        data: {
          runId: run.id,
          promptId: prompt.id,
          projectId: project.id,
          provider: 'mock_demo',
          country: 'US',
          language: 'en',
          promptText: prompt.text,
          status: 'SUCCEEDED',
          brandMentioned: mentioned,
          brandCited: cited,
          idempotencyKey: `${run.id}:${i}`,
          observedAt: new Date(now.getTime() - DAY),
        },
      });
    }
    const { queues, deps: d } = deps();
    await sendWeeklySummaries({ ...d, now: () => now });

    const deliveries = await prisma.emailDelivery.findMany({
      where: { userId: { in: [owner.id, optedOut.owner.id] }, template: 'weekly_summary' },
    });
    expect(deliveries.map((x) => x.userId)).toEqual([owner.id]);
    const job = queues.jobs.find(
      (j) => j.queue === 'email' && (j.data as { deliveryId: string }).deliveryId === deliveries[0]!.id,
    )!;
    const message = JSON.parse(
      decryptSecret((job.data as { encryptedMessage: string }).encryptedMessage),
    ) as { text: string };
    expect(message.text).toContain('site health index 80/100 (+10 since the previous audit)');
    expect(message.text).toContain('mentioned in 2 of 3 successful AI answers (67%)');
    expect(message.text).toContain('cited in 1 (33%)');

    await sendWeeklySummaries({ ...d, now: () => now });
    expect(
      await prisma.emailDelivery.count({ where: { userId: owner.id, template: 'weekly_summary' } }),
    ).toBe(1);
  });
});
