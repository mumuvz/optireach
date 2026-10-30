import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { GapAnalysisDto, GapAnalysisResult, GapBrand } from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import GapAnalysisPage from '@/pages/app/gap-analysis';
import { mockFetch, renderWithProviders } from './utils';

const brand = (overrides: Partial<GapBrand>): GapBrand => ({
  name: 'Shubhlink',
  key: 'shubhlink',
  isYou: false,
  competitorId: null,
  tracked: false,
  domain: null,
  answers: 0,
  mentionRate: 0,
  citedAnswers: 0,
  promptIds: [],
  reasons: [],
  quotes: [],
  detection: 'ai_extraction',
  aliasSuggestion: null,
  ...overrides,
});

const you = brand({ isYou: true, tracked: true, domain: 'shubhlink.test', detection: 'tracked' });
const canva = brand({
  name: 'Canva',
  key: 'canva',
  domain: 'canva.com',
  answers: 3,
  mentionRate: 0.75,
  reasons: [
    {
      attribute: 'indian templates',
      answers: 2,
      quotes: [
        {
          observationId: 'o1',
          promptId: 'p1',
          prompt: 'Best invitation app',
          provider: 'openai_web_search',
          observedAt: '2026-10-20T00:00:00.000Z',
          text: 'Lots of Indian wedding invitation templates',
        },
      ],
    },
  ],
});

const result: GapAnalysisResult = {
  version: 1,
  window: { from: '2026-07-22T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z', days: 90 },
  answers: 4,
  demoAnswersExcluded: 0,
  prompts: [
    {
      promptId: 'p1',
      prompt: 'Best invitation app',
      answers: 4,
      youNamed: 0,
      youCited: 0,
      brandsNamed: [{ name: 'Canva', answers: 3 }],
      topSources: [],
      attributes: [{ attribute: 'indian templates', answers: 2 }],
      answersNamingBrands: 3,
      recommendsBrands: true,
      yourPage: null,
      pageMatchAvailable: true,
    },
  ],
  providers: ['openai_web_search'],
  you,
  brands: [you, canva],
  attributes: [
    {
      attribute: 'indian templates',
      answers: 2,
      brands: ['Canva'],
      example: 'Lots of Indian wedding invitation templates',
      onYourSite: false,
      matchedOn: null,
    },
  ],
  sources: [],
  readiness: {
    robots: {
      url: 'https://shubhlink.test/robots.txt',
      status: 'ok',
      httpStatus: 200,
      error: null,
      agents: [],
    },
    homepage: {
      url: 'https://shubhlink.test/',
      status: 'OK',
      httpStatus: 200,
      title: 'Shubhlink',
      metaDescription: null,
      h1: 'Digital invitations',
      wordCount: 500,
      schemaTypes: ['Organization'],
      error: null,
    },
    audit: null,
  },
  actions: [
    {
      key: 'track-brands',
      priority: 3,
      category: 'GEO',
      title: 'Track Canva as competitors',
      why: 'Canva (named in 3 of 4 answers) is not tracked.',
      steps: ['Add them as competitors.'],
      evidence: { promptIds: [], urls: [], observationIds: [], brands: ['Canva'] },
      link: null,
      trackBrands: [{ name: 'Canva', domain: 'canva.com' }],
    },
  ],
  method: {
    brandDetection: 'ai_extraction',
    extractionModel: 'gpt-test',
    answersExtracted: 4,
    liveChecks: true,
  },
  notes: [],
};

const analysis: GapAnalysisDto = {
  id: 'a1',
  projectId: 'p1',
  status: 'SUCCEEDED',
  createdAt: '2026-10-20T00:00:00.000Z',
  startedAt: '2026-10-20T00:00:00.000Z',
  finishedAt: '2026-10-20T00:01:00.000Z',
  errorMessage: null,
  jobId: 'j1',
  newAnswersSince: 2,
  result,
};

function mockApp(latest: GapAnalysisDto | null, projectOverrides: Record<string, unknown> = {}) {
  document.cookie = 'sf_csrf=t';
  return mockFetch({
    'GET /api/v1/auth/me': {
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
    },
    'GET /api/v1/projects/p1': {
      body: {
        data: {
          id: 'p1',
          workspaceId: 'w1',
          name: 'Shubhlink',
          websiteUrl: 'https://shubhlink.test/',
          domain: 'shubhlink.test',
          isDemo: false,
          brandAliases: [],
          competitors: [],
          targetCountries: ['IN'],
          targetLanguages: ['en'],
          primaryKeywords: [],
          ...projectOverrides,
        },
      },
    },
    'GET /api/v1/projects/p1/gap-analyses/latest': { body: { data: latest } },
    'POST /api/v1/projects/p1/gap-analyses/a1/recommendations': {
      body: { data: { created: true, recommendation: { id: 'r1' } } },
    },
    'POST /api/v1/projects/p1/competitors': { status: 201, body: { data: { id: 'c9' } } },
  });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path="gaps" element={<GapAnalysisPage />} />
      </Route>
    </Routes>,
    { route: '/app/p/p1/gaps' },
  );
}

describe('GapAnalysisPage', () => {
  it('explains the empty state and links to AI checks', async () => {
    mockApp(null);
    renderPage();
    expect(await screen.findByText('Find out why AI recommends other brands')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /AI Visibility/ })).toHaveAttribute(
      'href',
      '/app/p/p1/visibility',
    );
  });

  it('shows a needs-a-website state (and no run button) for a business with no website', async () => {
    mockApp(null, { websiteUrl: null, domain: null });
    renderPage();
    expect(await screen.findByText('Competitor gaps needs a website')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a website' })).toHaveAttribute(
      'href',
      '/app/p/p1/settings#website',
    );
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
  });

  it('shows the evidence and turns actions into recommendations and tracked competitors', async () => {
    const calls = mockApp(analysis);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Action plan' })).toBeInTheDocument();
    expect(screen.getByText(/2 answers arrived after this analysis started/)).toBeInTheDocument();
    expect(screen.getByText('Track Canva as competitors')).toBeInTheDocument();
    expect(screen.getAllByText(/Lots of Indian wedding invitation templates/).length).toBeGreaterThan(0);
    expect(screen.getByText('No page targets this')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add to recommendations/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/recommendations'))).toBe(true),
    );
    const saved = calls.find((c) => c.path.endsWith('/recommendations'))!;
    expect(JSON.parse(String(saved.init.body))).toEqual({ actionKey: 'track-brands' });

    await userEvent.click(screen.getByRole('button', { name: 'Track Canva' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/competitors'))).toBe(true),
    );
    const tracked = calls.find((c) => c.method === 'POST' && c.path.endsWith('/competitors'))!;
    expect(JSON.parse(String(tracked.init.body))).toEqual({ name: 'Canva', domain: 'canva.com' });
  });
});
