import { executeAuditJob, executeCrawlJob } from '@surfaced/core/audit';
import { disconnectPrisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { JobTracker } from '@surfaced/core/jobs';
import type { AuditJobData, CrawlJobData, MemoryQueueGateway } from '@surfaced/core/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_TEST_FIXTURE_PORT,
  startFixtureSite,
  type FixtureSite,
} from '../../../packages/core/test/fixtures/fixture-site';
import { createTestApp, registerClient, TestClient } from './helpers';

const { app, queues, prisma } = createTestApp();
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite({ port: API_TEST_FIXTURE_PORT });
});
afterAll(async () => {
  await site.close();
  await disconnectPrisma();
});

/** Plays the worker: runs queued crawl jobs, then the audit jobs they enqueue. */
async function runWorker(gateway: MemoryQueueGateway) {
  const deps = { prisma, queues: gateway, fetcherOptions: { allowlist: getEnv().crawlerDevAllowlist } };
  for (const job of gateway.drain('crawl')) {
    const data = job.data as CrawlJobData;
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    if (!(await tracker.start(1))) continue;
    const outcome = await executeCrawlJob(deps, data.crawlJobId, tracker);
    if (outcome.status === 'cancelled') await tracker.cancel();
    else await tracker.succeed();
  }
  for (const job of gateway.drain('audit')) {
    const data = job.data as AuditJobData;
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await tracker.start(1);
    await executeAuditJob(deps, data, tracker);
    await tracker.succeed();
  }
}

async function ownerWithProject() {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Fixture Outdoor',
    websiteUrl: site.origin,
    targetCountries: ['US'],
    targetLanguages: ['en'],
  });
  expect(res.status).toBe(201);
  return { ...owner, projectId: res.body.data.id as string };
}

describe('audit lifecycle through the API', () => {
  it('starts an audit, runs it, and exposes results, pages and issues', async () => {
    const { client, projectId } = await ownerWithProject();
    const start = await client.post(`/projects/${projectId}/audits`, {});
    expect(start.status).toBe(202);
    const { jobId, auditRunId } = start.body.data;
    expect(queues.jobs.some((j) => j.queue === 'crawl' && j.jobId === jobId)).toBe(true);

    const concurrent = await client.post(`/projects/${projectId}/audits`, {});
    expect(concurrent.status).toBe(409);

    const queued = await client.get(`/audits/${auditRunId}`);
    expect(queued.body.data).toMatchObject({ status: 'QUEUED', crawl: { status: 'QUEUED' } });
    expect(queued.body.data.jobs.crawl.id).toBe(jobId);

    await runWorker(queues);

    const detail = await client.get(`/audits/${auditRunId}`);
    expect(detail.body.data.status).toBe('SUCCEEDED');
    expect(detail.body.data.score).toBeGreaterThan(0);
    expect(detail.body.data.crawl.pagesCrawled).toBeGreaterThan(5);
    expect(detail.body.data.limitations.length).toBeGreaterThan(0);
    expect(detail.body.data.jobs.crawl.status).toBe('SUCCEEDED');

    const list = await client.get(`/projects/${projectId}/audits`);
    expect(list.body.data[0]).toMatchObject({ id: auditRunId, status: 'SUCCEEDED' });

    const pages = await client.get(`/audits/${auditRunId}/pages?statusClass=4xx`);
    expect(pages.body.data.map((p: { url: string }) => new URL(p.url).pathname)).toEqual(['/broken']);
    const allPages = await client.get(`/audits/${auditRunId}/pages?pageSize=100&sort=url&order=asc`);
    const noTitle = allPages.body.data.find((p: { url: string }) => p.url.endsWith('/no-title'));
    const pageDetail = await client.get(`/audits/${auditRunId}/pages/${noTitle.id}`);
    expect(pageDetail.body.data.issues.map((i: { ruleId: string }) => i.ruleId)).toContain('title-missing');
    expect(pageDetail.body.data.inlinks.length).toBeGreaterThan(0);

    const high = await client.get(`/projects/${projectId}/issues?severity=HIGH,CRITICAL&pageSize=100`);
    expect(high.body.data.length).toBeGreaterThan(0);
    expect(high.body.data.every((i: { severity: string }) => ['HIGH', 'CRITICAL'].includes(i.severity))).toBe(
      true,
    );
    expect(high.body.meta.total).toBe(high.body.data.length);

    const summary = await client.get(`/projects/${projectId}/issues/summary`);
    expect(
      summary.body.data.rules.find((r: { ruleId: string }) => r.ruleId === 'title-duplicate').count,
    ).toBe(2);

    const issue = high.body.data[0];
    const ignored = await client.patch(`/issues/${issue.id}`, { status: 'IGNORED' });
    expect(ignored.body.data.status).toBe('IGNORED');
    const issueDetail = await client.get(`/issues/${issue.id}`);
    expect(issueDetail.body.data.history[0].auditRunId).toBe(auditRunId);
    const openOnly = await client.get(`/projects/${projectId}/issues?pageSize=100`);
    expect(openOnly.body.data.some((i: { id: string }) => i.id === issue.id)).toBe(false);

    const runIssues = await client.get(`/audits/${auditRunId}/issues?category=METADATA`);
    expect(runIssues.body.data.every((i: { category: string }) => i.category === 'METADATA')).toBe(true);
  });

  it('cancels a queued audit before it starts', async () => {
    const { client, projectId } = await ownerWithProject();
    const start = await client.post(`/projects/${projectId}/audits`, {});
    const cancel = await client.post(`/audits/${start.body.data.auditRunId}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(cancel.body.data.crawl.status).toBe('CANCELLED');
    expect(queues.jobs.some((j) => j.jobId === start.body.data.jobId)).toBe(false);
  });

  it('enforces the monthly audit allowance of the Free plan', async () => {
    const { client, projectId } = await ownerWithProject();
    for (let i = 0; i < 4; i++) {
      const res = await client.post(`/projects/${projectId}/audits`, {});
      expect(res.status).toBe(202);
      // Mark as finished so the next start is not blocked by the "already running" guard.
      await prisma.crawlJob.update({
        where: { id: res.body.data.crawlJobId },
        data: { status: 'SUCCEEDED' },
      });
    }
    const fifth = await client.post(`/projects/${projectId}/audits`, {});
    expect(fifth.status).toBe(402);
    expect(fifth.body.error.details).toMatchObject({ metric: 'AUDIT_RUN', limit: 4, used: 4 });
    queues.drain('crawl');
  });
});

describe('audit tenant isolation', () => {
  it("prevents user A from reading user B's audit, pages, issues and crawl job", async () => {
    const b = await ownerWithProject();
    const start = await b.client.post(`/projects/${b.projectId}/audits`, {});
    await runWorker(queues);
    const { auditRunId, crawlJobId } = start.body.data;
    const issues = await b.client.get(`/projects/${b.projectId}/issues`);
    const issueId = issues.body.data[0].id;
    const pages = await b.client.get(`/audits/${auditRunId}/pages`);
    const pageId = pages.body.data[0].id;

    const a = await registerClient(app);
    for (const path of [
      `/audits/${auditRunId}`,
      `/audits/${auditRunId}/pages`,
      `/audits/${auditRunId}/pages/${pageId}`,
      `/audits/${auditRunId}/issues`,
      `/issues/${issueId}`,
      `/projects/${b.projectId}/issues`,
      `/projects/${b.projectId}/audits`,
      `/crawl/jobs/${crawlJobId}`,
    ]) {
      const res = await a.client.get(path);
      expect(res.status, path).toBe(404);
    }
    expect((await a.client.patch(`/issues/${issueId}`, { status: 'IGNORED' })).status).toBe(404);
    expect((await a.client.post(`/projects/${b.projectId}/audits`, {})).status).toBe(404);
    expect((await a.client.post(`/audits/${auditRunId}/rescore`)).status).toBe(404);
  });
});

describe('free public audit', () => {
  it('runs an anonymous audit readable only with its token', async () => {
    const anon = await new TestClient(app).init();
    const start = await anon.post('/public/audits', { url: site.origin });
    expect(start.status).toBe(202);
    const { id, token } = start.body.data;
    await runWorker(queues);
    const result = await anon.get(`/public/audits/${id}?token=${token}`);
    expect(result.body.data.status).toBe('SUCCEEDED');
    expect(result.body.data.result.topIssues.length).toBeGreaterThan(0);
    expect(result.body.data.result.scoring.note).toMatch(/not a Google ranking score/);
    expect((await anon.get(`/public/audits/${id}?token=${'x'.repeat(32)}`)).status).toBe(404);

    const blocked = await anon.post('/public/audits', { url: 'http://169.254.169.254/' });
    expect(blocked.status).toBe(422);
  });
});
