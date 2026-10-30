// Development seed (`npm run db:seed`).
//
// Creates the default plans, an admin account, a demo account and a demo workspace. Every number in
// the demo workspace is computed by the production code paths: the real crawler and audit engine
// analyze an in-memory demo website (prisma/seed/demo-site.ts), and the deterministic demo AI
// provider produces visibility observations labeled as demo data. The seed makes no network
// requests and never calls an LLM.
//
// Safe to run repeatedly. Existing accounts are never modified (passwords included), and if the demo
// workspace already exists, demo data is not re-created unless `--reset-demo` is passed
// (`npm run db:seed:reset-demo`), which deletes and rebuilds only a workspace holding demo
// projects. With NODE_ENV=production only the plans are ensured; demo accounts and data are refused.
import { activateDevSubscription, ensureDefaultPlans } from '@surfaced/core/billing';
import { executeAuditJob, executeCrawlJob } from '@surfaced/core/audit';
import { hashPassword } from '@surfaced/core/crypto';
import { disconnectPrisma, getPrisma, type PrismaClient } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { JobTracker, createJobRecord } from '@surfaced/core/jobs';
import { MemoryQueueGateway, type AuditJobData } from '@surfaced/core/queue';
import { syncVisibilityRecommendations } from '@surfaced/core/recommendations';
import { clampCrawlSettings } from '@surfaced/core/scheduling';
import { executeVisibilityRun, nextPromptRun } from '@surfaced/core/visibility';
import { DEFAULT_PLAN_KEY, DEFAULT_SCORING_CONFIG, emailSchema, passwordSchema } from '@surfaced/shared';
import { DEMO_BRAND, DEMO_COMPETITORS, DEMO_HOST, DEMO_ORIGIN, DemoSiteFetcher } from './seed/demo-site';

const DEMO_WORKSPACE_SLUG = 'demo-workspace';
/** Demo addresses use the reserved .test TLD and receive no email. */
const NO_EMAIL_PREFS = { auditCompleted: false, reportReady: false, weeklySummary: false, billing: false };

const DEMO_PROMPTS = [
  'best lightweight backpacking tent for two people',
  'where to buy a waterproof hiking jacket online',
  'recommended outdoor gear shops with honest reviews',
  'best 30 litre daypack for day hikes',
  'how to choose a tent for winter camping',
];
const DEMO_KEYWORDS = [
  'backpacking tent',
  'two person tent',
  'waterproof hiking jacket',
  'daypack 30l',
  'winter layering guide',
  'how to choose a tent',
];

function log(message: string): void {
  console.log(`[seed] ${message}`);
}

async function ensureUser(
  prisma: PrismaClient,
  input: { email: string; name: string; password: string; admin: boolean; workspaceName: string },
) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    log(`${input.email} already exists — left unchanged.`);
    return existing;
  }
  const freePlan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: DEFAULT_PLAN_KEY } });
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        emailVerifiedAt: new Date(),
        platformRole: input.admin ? 'ADMIN' : 'USER',
        notificationPrefs: NO_EMAIL_PREFS,
      },
    });
    const workspace = await tx.workspace.create({
      data: {
        name: input.workspaceName,
        slug: `${input.admin ? 'admin' : 'demo-user'}-${created.id.slice(-6)}`,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: created.id, role: 'OWNER' },
    });
    await tx.subscription.create({
      data: { workspaceId: workspace.id, planId: freePlan.id, status: 'ACTIVE', provider: 'NONE' },
    });
    return tx.user.update({ where: { id: created.id }, data: { lastWorkspaceId: workspace.id } });
  });
  log(`Created ${input.admin ? 'admin' : 'demo'} account ${input.email}.`);
  return user;
}

/** Runs a tracked job inline, the way the worker would. */
async function runInline<T>(
  prisma: PrismaClient,
  jobId: string,
  work: (tracker: JobTracker) => Promise<T>,
): Promise<T> {
  const tracker = new JobTracker(prisma, jobId);
  await tracker.start(1);
  try {
    const result = await work(tracker);
    await tracker.succeed(JSON.parse(JSON.stringify(result ?? null)));
    return result;
  } catch (error) {
    await tracker.fail(error, true);
    throw error;
  }
}

async function seedDemoWorkspace(prisma: PrismaClient, demoUserId: string, reset: boolean): Promise<void> {
  const existing = await prisma.workspace.findUnique({
    where: { slug: DEMO_WORKSPACE_SLUG },
    include: { projects: { select: { isDemo: true } } },
  });
  if (existing && !reset) {
    log(
      'Demo workspace already exists — demo data not re-created (run npm run db:seed:reset-demo to rebuild it).',
    );
    return;
  }
  if (existing) {
    if (existing.projects.some((p) => !p.isDemo)) {
      log(
        'The demo workspace contains a project that is not demo data, so it was not reset. Move or delete that project first.',
      );
      return;
    }
    await prisma.workspace.delete({ where: { id: existing.id } });
    log('Deleted the previous demo workspace (demo data only).');
  }
  const workspace = await prisma.workspace.create({
    data: { name: 'Demo workspace', slug: DEMO_WORKSPACE_SLUG },
  });
  try {
    await populateDemoWorkspace(prisma, workspace.id, demoUserId);
  } catch (error) {
    // Remove the partly built demo workspace (it was created by this run) so the next run starts clean.
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    throw error;
  }
}

async function populateDemoWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
  demoUserId: string,
): Promise<void> {
  const workspace = { id: workspaceId };
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: demoUserId, role: 'OWNER' },
  });
  // Development billing only: the Growth plan unlocks competitors and daily checks for the demo.
  await activateDevSubscription(prisma, workspace.id, 'GROWTH', 'YEAR');
  await prisma.user.update({ where: { id: demoUserId }, data: { lastWorkspaceId: workspace.id } });

  const growth = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: 'GROWTH' } });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: `${DEMO_BRAND} (demo)`,
      websiteUrl: `${DEMO_ORIGIN}/`,
      domain: DEMO_HOST,
      brandAliases: ['Northwind'],
      industry: 'ecommerce',
      description:
        'Fictional outdoor-gear retailer used for the product demo. All results in this project are demo data.',
      targetCountries: ['US'],
      targetLanguages: ['en'],
      crawlSettings: clampCrawlSettings({}, growth.limits as never),
      isDemo: true,
      createdById: demoUserId,
    },
  });
  const competitors = await Promise.all(
    DEMO_COMPETITORS.map((c) =>
      prisma.projectCompetitor.create({
        data: {
          projectId: project.id,
          name: c.name,
          domain: c.domain,
          aliases: c.aliases,
          notes: 'Fictional competitor (demo).',
        },
      }),
    ),
  );
  log(`Created demo project ${project.name}.`);

  // ---- Audit: real crawler + analyzer over the in-memory site ----
  const queues = new MemoryQueueGateway();
  const crawl = await prisma.crawlJob.create({
    data: {
      projectId: project.id,
      // The demo project always has a website.
      startUrl: project.websiteUrl!,
      settings: project.crawlSettings as never,
      trigger: 'SYSTEM',
      createdById: demoUserId,
      isDemo: true,
    },
  });
  const run = await prisma.auditRun.create({
    data: {
      projectId: project.id,
      crawlJobId: crawl.id,
      scoringVersion: DEFAULT_SCORING_CONFIG.version,
      weights: DEFAULT_SCORING_CONFIG as never,
      isDemo: true,
    },
  });
  const crawlJob = await createJobRecord(prisma, {
    type: 'CRAWL',
    queue: 'crawl',
    workspaceId: workspace.id,
    projectId: project.id,
    userId: demoUserId,
    entityType: 'CrawlJob',
    entityId: crawl.id,
    payload: { crawlJobId: crawl.id, auditRunId: run.id, demo: true },
  });
  const fetcher = new DemoSiteFetcher();
  try {
    await runInline(prisma, crawlJob.id, (tracker) =>
      executeCrawlJob({ prisma, queues, fetcher }, crawl.id, tracker),
    );
  } finally {
    await fetcher.close();
  }
  for (const queued of queues.drain('audit')) {
    await runInline(prisma, queued.jobId, (tracker) =>
      executeAuditJob({ prisma, queues }, queued.data as AuditJobData, tracker),
    );
  }
  const audited = await prisma.auditRun.findUniqueOrThrow({ where: { id: run.id } });
  log(`Demo audit: ${audited.pagesAnalyzed ?? '?'} pages, site health index ${audited.score ?? 'n/a'}.`);

  // ---- AI visibility: deterministic demo provider, no LLM verification ----
  if (!getEnv().AI_DEMO_MODE) {
    log('AI_DEMO_MODE is false, so demo visibility observations were not created.');
  } else {
    const now = new Date();
    for (const text of DEMO_PROMPTS) {
      await prisma.aiPrompt.create({
        data: {
          projectId: project.id,
          text,
          country: 'US',
          language: 'en',
          targetBrand: DEMO_BRAND,
          providers: ['mock_demo'],
          frequency: 'WEEKLY',
          nextRunAt: nextPromptRun('WEEKLY', now),
          competitors: { create: competitors.map((c) => ({ competitorId: c.id })) },
        },
      });
    }
    const visibilityRun = await prisma.aiVisibilityRun.create({
      data: { projectId: project.id, trigger: 'SYSTEM', promptCount: DEMO_PROMPTS.length, isDemo: true },
    });
    const outcome = await executeVisibilityRun(prisma, visibilityRun.id, null, null, null);
    await syncVisibilityRecommendations(prisma, project.id);
    log(`Demo visibility run: ${outcome.succeeded} demo observations.`);
  }

  // ---- Keywords: phrases only; no search metrics without a licensed provider ----
  const list = await prisma.keywordList.create({
    data: {
      projectId: project.id,
      name: 'Demo keywords',
      description: 'Phrases only. Search volume and difficulty need a keyword data provider.',
    },
  });
  await prisma.projectKeyword.createMany({
    data: DEMO_KEYWORDS.map((phrase, index) => ({
      projectId: project.id,
      listId: list.id,
      phrase,
      normalizedPhrase: phrase,
      country: 'US',
      language: 'en',
      isPrimary: index < 3,
    })),
  });
}

async function main(): Promise<void> {
  const env = getEnv();
  const prisma = getPrisma();
  try {
    await ensureDefaultPlans(prisma);
    log('Default plans are present (existing plans were not modified).');

    if (env.isProduction) {
      log('NODE_ENV=production: demo accounts and demo data are never created in production.');
      return;
    }
    const password = process.env.SEED_DEMO_PASSWORD;
    const parsedPassword = passwordSchema.safeParse(password ?? '');
    if (!parsedPassword.success) {
      log(
        'SEED_DEMO_PASSWORD is missing or too weak; skipping demo accounts. Set it in .env and run the seed again.',
      );
      return;
    }
    const adminEmail = emailSchema.parse(process.env.SEED_ADMIN_EMAIL ?? 'admin@surfaced.test');
    const demoEmail = emailSchema.parse(process.env.SEED_DEMO_EMAIL ?? 'demo@surfaced.test');

    await ensureUser(prisma, {
      email: adminEmail,
      name: 'Platform Admin',
      password: parsedPassword.data,
      admin: true,
      workspaceName: 'Admin workspace',
    });
    const demo = await ensureUser(prisma, {
      email: demoEmail,
      name: 'Demo User',
      password: parsedPassword.data,
      admin: false,
      workspaceName: 'Personal workspace',
    });
    await seedDemoWorkspace(prisma, demo.id, process.argv.includes('--reset-demo'));
    log(`Done. Sign in as ${demoEmail} or ${adminEmail} with SEED_DEMO_PASSWORD.`);
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] Failed:', error);
  process.exitCode = 1;
});
