import { ProviderError, type LlmProvider } from '@surfaced/core/ai';
import { executeBriefIdeas, executeContentGeneration } from '@surfaced/core/content';
import { disconnectPrisma } from '@surfaced/core/db';
import { JobTracker } from '@surfaced/core/jobs';
import type { ContentJobData, MemoryQueueGateway } from '@surfaced/core/queue';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, emailTokenFor, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function runContentJobs(gateway: MemoryQueueGateway) {
  for (const job of gateway.drain('content')) {
    const data = job.data as ContentJobData;
    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: data.backgroundJobId } });
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await tracker.start(1);
    const result = await executeContentGeneration(prisma, data.backgroundJobId, record.payload as never);
    await tracker.succeed(result as never);
  }
}

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Trailhead Gear',
    websiteUrl: 'trailhead-gear.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
  });
  const projectId = project.body.data.id as string;
  const brief = await owner.client.post(`/projects/${projectId}/content/briefs`, {
    title: 'How to choose hiking boots',
    primaryKeyword: 'hiking boots',
    secondaryKeywords: ['waterproof boots'],
    searchIntent: 'COMMERCIAL',
    targetAudience: 'Beginner hikers',
    country: 'US',
    language: 'en',
    wordCountTarget: 800,
  });
  const doc = await owner.client.post(`/projects/${projectId}/content/documents`, {
    title: 'How to choose hiking boots',
    briefId: brief.body.data.id,
  });
  return {
    ...owner,
    projectId,
    briefId: brief.body.data.id as string,
    documentId: doc.body.data.id as string,
  };
}

describe('content drafts and generation', () => {
  it('creates a draft, generates every mode with the labeled dev adapter, and keeps version history', async () => {
    const { client, documentId, workspaceId } = await setup();
    // Six generations exceed the Free allowance (3/month); use Growth for this flow.
    const growth = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: 'GROWTH' } });
    await prisma.subscription.update({ where: { workspaceId }, data: { planId: growth.id } });
    const doc = await client.get(`/content/documents/${documentId}`);
    expect(doc.body.data).toMatchObject({ status: 'DRAFT', latestVersion: 1, editable: true });
    expect(doc.body.data.generation).toMatchObject({ provider: 'dev', isDevAdapter: true });

    for (const mode of ['outline', 'article', 'meta', 'faq']) {
      const res = await client.post(`/content/documents/${documentId}/generate`, { mode });
      expect(res.status, mode).toBe(202);
      await runContentJobs(queues);
    }
    const afterArticle = await client.get(`/content/documents/${documentId}`);
    const version = afterArticle.body.data.currentVersion;
    expect(version.isDevAdapter).toBe(true);
    expect(version.body).toContain('Development adapter output');
    expect(version.metaTitle).toBeTruthy();
    expect(version.faqs.length).toBeGreaterThan(0);

    const section = await client.post(`/content/documents/${documentId}/generate`, {
      mode: 'section',
      sectionHeading: 'Why hiking boots matters',
    });
    expect(section.status).toBe(202);
    await runContentJobs(queues);
    const afterSection = (await client.get(`/content/documents/${documentId}`)).body.data.currentVersion;
    expect(afterSection.source).toBe('AI_SECTION');

    await client.post(`/content/documents/${documentId}/generate`, { mode: 'schema' });
    await runContentJobs(queues);
    const withSchema = (await client.get(`/content/documents/${documentId}`)).body.data.currentVersion;
    const graph = withSchema.schemaJsonLd['@graph'];
    expect(graph.map((n: { '@type': string }) => n['@type'])).toEqual(['Article', 'FAQPage']);

    const saved = await client.post(`/content/documents/${documentId}/versions`, {
      title: 'Choosing hiking boots',
      body: '## Fit\n\nTry boots on in the afternoon.',
      note: 'Manual edit',
    });
    expect(saved.status).toBe(201);
    expect(saved.body.data.source).toBe('MANUAL');
    const versions = await client.get(`/content/documents/${documentId}/versions`);
    expect(versions.body.data.length).toBe(saved.body.data.versionNumber);
    const outlineVersion = versions.body.data.find((v: { versionNumber: number }) => v.versionNumber === 2);
    const restored = await client.post(
      `/content/documents/${documentId}/versions/${outlineVersion.id}/restore`,
    );
    expect(restored.body.data).toMatchObject({ source: 'RESTORE', note: 'Restored from version 2' });

    const links = await client.get(`/content/documents/${documentId}/internal-links`);
    expect(links.body.data).toEqual({ suggestions: [], crawledAt: null }); // no crawl yet: nothing invented
  });

  it('rejects invalid generation input', async () => {
    const { client, documentId } = await setup();
    expect((await client.post(`/content/documents/${documentId}/generate`, { mode: 'section' })).status).toBe(
      400,
    );
    expect((await client.post(`/content/documents/${documentId}/generate`, { mode: 'novel' })).status).toBe(
      400,
    );
    expect(
      (
        await client.post(`/content/documents/${documentId}/generate`, {
          mode: 'article',
          instructions: 'x'.repeat(2001),
        })
      ).status,
    ).toBe(400);
  });

  it('handles provider failures without writing a version', async () => {
    const { documentId } = await setup();
    const failing: LlmProvider = {
      key: 'openai',
      label: 'Failing',
      isDevAdapter: false,
      generateJson: async () => {
        throw new ProviderError('RATE_LIMITED', 'Upstream limit', true);
      },
    };
    const before = await prisma.contentVersion.count({ where: { documentId } });
    await expect(
      executeContentGeneration(prisma, 'job-fail-1', { documentId, mode: 'article' }, failing),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(
      executeContentGeneration(prisma, 'job-fail-2', { documentId, mode: 'article' }, null),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(await prisma.contentVersion.count({ where: { documentId } })).toBe(before);
  });

  it('enforces the monthly generation allowance', async () => {
    const { client, documentId } = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await client.post(`/content/documents/${documentId}/generate`, { mode: 'meta' })).status).toBe(
        202,
      );
      await runContentJobs(queues);
    }
    const fourth = await client.post(`/content/documents/${documentId}/generate`, { mode: 'meta' });
    expect(fourth.status).toBe(402);
    // Schema generation is deterministic and does not consume the allowance.
    expect((await client.post(`/content/documents/${documentId}/generate`, { mode: 'schema' })).status).toBe(
      202,
    );
    queues.drain('content');
  });
});

describe('approval workflow', () => {
  it('requires owners/admins to approve and blocks editing approved content', async () => {
    const owner = await setup();
    await prisma.user.update({ where: { email: owner.email }, data: { emailVerifiedAt: new Date() } });
    const growth = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: 'GROWTH' } });
    await prisma.subscription.update({
      where: { workspaceId: owner.workspaceId },
      data: { planId: growth.id },
    });
    const member = await registerClient(app);
    await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: member.email,
      role: 'MEMBER',
    });
    await member.client.post('/workspaces/invitations/accept', {
      token: await emailTokenFor(queues, member.email, 'workspace_invitation'),
    });

    const submit = await member.client.patch(`/content/documents/${owner.documentId}`, {
      status: 'IN_REVIEW',
    });
    expect(submit.status).toBe(200);
    expect(submit.body.data.allowedTransitions).toEqual(['DRAFT', 'ARCHIVED']);
    const memberApprove = await member.client.patch(`/content/documents/${owner.documentId}`, {
      status: 'APPROVED',
    });
    expect(memberApprove.status).toBe(403);

    const approve = await owner.client.patch(`/content/documents/${owner.documentId}`, {
      status: 'APPROVED',
    });
    expect(approve.body.data).toMatchObject({ status: 'APPROVED', editable: false });
    expect(approve.body.data.approvedBy.name).toBe('Test User');
    expect(
      (
        await owner.client.post(`/content/documents/${owner.documentId}/versions`, {
          title: 'Edit',
          body: 'Nope',
        })
      ).status,
    ).toBe(409);
    expect(
      (await owner.client.post(`/content/documents/${owner.documentId}/generate`, { mode: 'meta' })).status,
    ).toBe(409);

    const publish = await owner.client.patch(`/content/documents/${owner.documentId}`, {
      status: 'PUBLISHED',
    });
    expect(publish.body.data.publishedAt).not.toBeNull();
    const back = await owner.client.patch(`/content/documents/${owner.documentId}`, { status: 'DRAFT' });
    expect(back.body.data.editable).toBe(true);
    expect(
      (await owner.client.patch(`/content/documents/${owner.documentId}`, { status: 'PUBLISHED' })).status,
    ).toBe(409);

    const assign = await owner.client.patch(`/content/documents/${owner.documentId}`, {
      assigneeId: member.me.user.id,
    });
    expect(assign.body.data.assignee.id).toBe(member.me.user.id);
  });
});

describe('export and isolation', () => {
  it('exports Markdown and escaped HTML as downloads', async () => {
    const { client, documentId } = await setup();
    await client.post(`/content/documents/${documentId}/versions`, {
      title: 'Safe export',
      body: 'Hello <script>alert(1)</script>\n\n## Section',
      metaDescription: 'Desc',
    });
    const md = await client.get(`/content/documents/${documentId}/export?format=md`);
    expect(md.headers['content-disposition']).toMatch(
      /attachment; filename="safe-export\.md"|how-to-choose-hiking-boots\.md/,
    );
    expect(md.text).toContain('# Safe export');
    const html = await client.get(`/content/documents/${documentId}/export?format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).not.toContain('<script>alert(1)</script>');
    expect(html.text).toContain('&lt;script&gt;');
  });

  it("prevents access to another workspace's content", async () => {
    const b = await setup();
    const a = await registerClient(app);
    for (const path of [
      `/content/documents/${b.documentId}`,
      `/content/documents/${b.documentId}/versions`,
      `/content/briefs/${b.briefId}`,
      `/content/documents/${b.documentId}/export`,
      `/projects/${b.projectId}/content/documents`,
      `/projects/${b.projectId}/content/brief-providers`,
    ]) {
      expect((await a.client.get(path)).status, path).toBe(404);
    }
    expect(
      (await a.client.post(`/content/documents/${b.documentId}/generate`, { mode: 'outline' })).status,
    ).toBe(404);
    expect(
      (await a.client.post(`/projects/${b.projectId}/content/briefs/suggest`, { seed: 'coffee', country: 'US', language: 'en' })).status, // prettier-ignore
    ).toBe(404);
    expect((await a.client.patch(`/content/documents/${b.documentId}`, { status: 'IN_REVIEW' })).status).toBe(
      404,
    );
  });
});

describe('AI question + brief generation', () => {
  it('generates a brief proposal on the chosen provider and refuses an unconfigured one', async () => {
    const { client, projectId } = await setup();

    // Lists the LLM providers: only the development adapter is configured in tests, and it is the default.
    const providers = (await client.get(`/projects/${projectId}/content/brief-providers`)).body.data as {
      key: string;
      configured: boolean;
      isDefault: boolean;
    }[];
    expect(providers.map((p) => p.key)).toEqual(['openai', 'gemini', 'dev']);
    expect(providers.find((p) => p.key === 'dev')).toMatchObject({ configured: true, isDefault: true });

    // Choosing a provider with no key fails immediately rather than enqueuing a dead job.
    const refused = await client.post(`/projects/${projectId}/content/briefs/suggest`, {
      seed: 'cold brew coffee for offices',
      country: 'US',
      language: 'en',
      provider: 'gemini',
    });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    // The default (development) provider enqueues a job and records the topic + provider for the worker.
    const start = await client.post(`/projects/${projectId}/content/briefs/suggest`, {
      seed: 'cold brew coffee for offices',
      country: 'US',
      language: 'en',
      questionCount: 5,
    });
    expect(start.status).toBe(202);
    const [job] = queues.drain('content');
    const data = job!.data as ContentJobData;
    expect(data.kind).toBe('brief_ideas');
    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: data.backgroundJobId } });
    expect((record.payload as { seed: string; questionCount: number }).seed).toBe(
      'cold brew coffee for offices',
    );

    // Run the job (dev adapter) and confirm it yields a labelled proposal with questions and no metrics.
    const result = await executeBriefIdeas(prisma, data.backgroundJobId, record.payload as never);
    expect(result).toMatchObject({ provider: 'dev', isDevAdapter: true });
    expect(result.label).toMatch(/not AI-generated/);
    expect(result.proposal.questions.length).toBeGreaterThanOrEqual(3);
    expect(result.proposal.questions.length).toBeLessThanOrEqual(5);
    expect(result.proposal.primaryKeyword.length).toBeGreaterThan(0);
    expect(result.proposal.wordCountTarget).toBeGreaterThanOrEqual(300);
    expect(result.proposal.wordCountTarget).toBeLessThanOrEqual(4000);

    // The proposal saves through the existing create-brief endpoint.
    const saved = await client.post(`/projects/${projectId}/content/briefs`, {
      title: result.proposal.title,
      primaryKeyword: result.proposal.primaryKeyword,
      secondaryKeywords: result.proposal.secondaryKeywords,
      searchIntent: result.proposal.searchIntent,
      country: 'US',
      language: 'en',
      wordCountTarget: result.proposal.wordCountTarget,
      notes: result.proposal.questions.map((q) => `- ${q.question}`).join('\n'),
    });
    expect(saved.status).toBe(201);
    expect(saved.body.data.primaryKeyword).toBe(result.proposal.primaryKeyword);
  });
});
