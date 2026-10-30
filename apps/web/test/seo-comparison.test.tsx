import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { SeoComparisonDto, SeoComparisonResult } from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import GapAnalysisPage from '@/pages/app/gap-analysis';
import SeoComparisonPage from '@/pages/app/seo-comparison';
import { mockFetch, renderWithProviders, type MockResponse } from './utils';

const me = {
  body: {
    data: {
      user: {
        id: 'u1',
        email: 'owner@example.test',
        name: 'Owner',
        emailVerified: true,
        platformRole: 'USER',
      },
      memberships: [
        {
          workspaceId: 'w1',
          workspaceName: 'WS',
          workspaceSlug: 'ws',
          role: 'OWNER',
          via: 'DIRECT',
          agencyWorkspaceId: null,
          approvalsDelegated: false,
        },
      ],
      currentWorkspaceId: 'w1',
    },
  },
};

const project = {
  body: {
    data: {
      id: 'p1',
      workspaceId: 'w1',
      name: 'Shubhlink',
      websiteUrl: 'https://shubhlink.test/',
      domain: 'shubhlink.test',
      isDemo: false,
      brandAliases: [],
      competitors: [{ id: 'c1', name: 'Rival', domain: 'rival.test', aliases: [] }],
      targetCountries: ['IN'],
      targetLanguages: ['en'],
      primaryKeywords: ['digital invitation maker'],
    },
  },
};

function renderAt(path: string, element: React.ReactNode, routes: Record<string, MockResponse>) {
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({ 'GET /api/v1/auth/me': me, 'GET /api/v1/projects/p1': project, ...routes });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path={path} element={element} />
      </Route>
    </Routes>,
    { route: `/app/p/p1/${path}` },
  );
  return calls;
}

const result: SeoComparisonResult = {
  version: 1,
  maxPagesPerSite: 250,
  sites: [
    {
      key: 'you',
      name: 'Shubhlink',
      domain: 'shubhlink.test',
      isYou: true,
      competitorId: null,
      startUrl: 'https://shubhlink.test/',
      status: 'OK',
      error: null,
      pagesCrawled: 40,
      pagesAnalyzed: 40,
      limitReached: false,
      timeLimitReached: false,
      score: 90,
      categoryScores: null,
      rules: [],
      schemaTypes: ['Organization'],
      crawledAt: '2026-10-23T00:00:00.000Z',
    },
    {
      key: 'c1',
      name: 'Rival',
      domain: 'rival.test',
      isYou: false,
      competitorId: 'c1',
      startUrl: 'https://rival.test/',
      status: 'OK',
      error: null,
      pagesCrawled: 40,
      pagesAnalyzed: 40,
      limitReached: true,
      timeLimitReached: false,
      score: 95,
      categoryScores: null,
      rules: [],
      schemaTypes: ['Organization', 'Product'],
      crawledAt: '2026-10-23T00:00:00.000Z',
    },
  ],
  metrics: [
    {
      key: 'descriptionPct',
      values: { you: 0.4, c1: 0.95 },
      competitorMedian: 0.95,
      best: { siteKey: 'c1', value: 0.95 },
      status: 'behind',
    },
    {
      key: 'medianResponseMs',
      values: { you: 60, c1: 300 },
      competitorMedian: 300,
      best: { siteKey: 'you', value: 60 },
      status: 'ahead',
    },
  ],
  summary: { compared: 2, behind: 1, ahead: 1, even: 0 },
  suggestions: [
    {
      key: 'rule:meta-description-missing',
      priority: 2,
      category: 'TECHNICAL_SEO',
      title: 'Meta description is missing (24 pages)',
      why: '24 of 40 pages checked (60%). Competitors: Rival 5%.',
      steps: ['Write a unique description for each page.'],
      affectedPages: 24,
      evidence: { urls: [], ruleId: 'meta-description-missing', metricKey: null, competitors: ['Rival'] },
      link: { label: 'Open issues', path: 'issues' },
    },
  ],
  notes: ['Every site was checked the same way.'],
  notCompared: [
    'Backlinks and domain authority: these need a licensed backlink index, so they are not compared.',
  ],
};

const comparison: SeoComparisonDto = {
  id: 's1',
  projectId: 'p1',
  status: 'SUCCEEDED',
  createdAt: '2026-10-23T00:00:00.000Z',
  startedAt: '2026-10-23T00:00:00.000Z',
  finishedAt: '2026-10-23T00:03:00.000Z',
  errorMessage: null,
  jobId: 'j1',
  competitorIds: ['c1'],
  result,
};

describe('SeoComparisonPage', () => {
  it('shows how far behind the site is and saves suggestions', async () => {
    const calls = renderAt('seo-comparison', <SeoComparisonPage />, {
      'GET /api/v1/projects/p1/seo-comparisons/latest': { body: { data: comparison } },
      'POST /api/v1/projects/p1/seo-comparisons/s1/recommendations': {
        body: { data: { created: true, recommendation: { id: 'r1' } } },
      },
    });
    expect(await screen.findByText('Behind competitors on')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    const row = screen.getByText('Pages with a meta description').closest('tr')!;
    expect(within(row).getByText('40%')).toBeInTheDocument();
    expect(within(row).getByText('95%')).toBeInTheDocument();
    expect(within(row).getByText('Behind')).toBeInTheDocument();
    expect(
      within(screen.getByText('Median server response time').closest('tr')!).getByText('Ahead'),
    ).toBeInTheDocument();
    expect(screen.getByText(/licensed backlink index/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add to recommendations/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/s1/recommendations'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/s1/recommendations'))!.init.body));
    expect(body).toEqual({ suggestionKey: 'rule:meta-description-missing' });
  });

  it('starts a comparison with the chosen competitors', async () => {
    const calls = renderAt('seo-comparison', <SeoComparisonPage />, {
      'GET /api/v1/projects/p1/seo-comparisons/latest': { body: { data: null } },
      'POST /api/v1/projects/p1/seo-comparisons': { status: 202, body: { data: { jobId: 'j2' } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Run comparison/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/seo-comparisons'))).toBe(true),
    );
    const started = calls.find((c) => c.method === 'POST' && c.path.endsWith('/seo-comparisons'))!;
    expect(JSON.parse(String(started.init.body))).toEqual({ competitorIds: ['c1'] });
  });
});

describe('BulkPromptsDialog', () => {
  it('turns keywords into questions, previews them and adds them in one request', async () => {
    const calls = renderAt('gaps', <GapAnalysisPage />, {
      'GET /api/v1/projects/p1/gap-analyses/latest': { body: { data: null } },
      'GET /api/v1/ai-visibility/providers': {
        body: {
          data: {
            providers: [
              {
                key: 'openai_web_search',
                label: 'OpenAI · web search',
                kind: 'live_search',
                configured: true,
                status: 'configured',
                detail: '',
              },
            ],
            llm: { configured: true, isDevAdapter: false, detail: 'OpenAI' },
          },
        },
      },
      'POST /api/v1/projects/p1/prompts/bulk': {
        status: 201,
        body: { data: { created: [{ id: 'x' }], skipped: [] } },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Add keywords in bulk/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Use my primary keywords/ }));
    expect(screen.getByText('What is the best digital invitation maker?')).toBeInTheDocument();
    expect(screen.getByText('Best digital invitation maker in India')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Best digital invitation maker in India' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Add 1 prompt/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/prompts/bulk'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/prompts/bulk'))!.init.body));
    expect(body).toMatchObject({
      texts: ['What is the best digital invitation maker?'],
      country: 'IN',
      language: 'en',
      providers: ['openai_web_search'],
      competitorIds: ['c1'],
    });
  });
  it('generates keyword ideas with AI and fills keywords and questions', async () => {
    const calls = renderAt('gaps', <GapAnalysisPage />, {
      'GET /api/v1/projects/p1/gap-analyses/latest': { body: { data: null } },
      'GET /api/v1/ai-visibility/providers': {
        body: { data: { providers: [{ key: 'openai_web_search', label: 'OpenAI · web search', kind: 'live_search', configured: true, status: 'configured', detail: '' }], llm: { configured: true, isDevAdapter: false, detail: 'OpenAI' } } },
      },
      'POST /api/v1/projects/p1/keywords/suggest': { status: 202, body: { data: { jobId: 'k1', status: 'QUEUED' } } },
      'GET /api/v1/jobs/k1': {
        body: {
          data: {
            id: 'k1', type: 'KEYWORD_SUGGESTIONS', status: 'SUCCEEDED', progress: 100, message: 'Done', error: null, attempts: 1, maxAttempts: 2,
            entityType: 'Project', entityId: 'p1', cancelRequested: false, createdAt: '2026-10-23T00:00:00.000Z', startedAt: null, finishedAt: null,
            result: { isDevAdapter: false, label: 'AI-generated ideas', suggestions: [{ phrase: 'kankotri wedding invitation', relatedQuestions: ['What is Kankotri?'] }] },
          },
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Add keywords in bulk/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. haldi invitations'), 'wedding');
    await userEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText('What is the best kankotri wedding invitation?')).toBeInTheDocument();
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/keywords/suggest'))!.init.body));
    expect(body).toEqual({ seed: 'wedding', country: 'IN', language: 'en', count: 20 });
    // The related questions the AI suggested are ready in the Questions tab.
    await userEvent.click(screen.getByRole('tab', { name: 'Questions' }));
    expect(screen.getAllByText('What is Kankotri?').length).toBeGreaterThan(0);
  }); // prettier-ignore
});
