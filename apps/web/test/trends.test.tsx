import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { TrendProviderStatusDto, TrendReportDto, TrendsStatusDto } from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import TrendsPage from '@/pages/app/trends';
import { mockFetch, renderWithProviders, type MockResponse } from './utils';

const me = {
  body: {
    data: {
      user: { id: 'u1', email: 'owner@example.test', name: 'Owner', emailVerified: true, platformRole: 'USER' },
      memberships: [
        { workspaceId: 'w1', workspaceName: 'WS', workspaceSlug: 'ws', role: 'OWNER', via: 'DIRECT', agencyWorkspaceId: null, approvalsDelegated: false },
      ],
      currentWorkspaceId: 'w1',
    },
  },
}; // prettier-ignore

const project = {
  body: {
    data: {
      id: 'p1', workspaceId: 'w1', name: 'Shubhlink', websiteUrl: 'https://shubhlink.test/', domain: 'shubhlink.test',
      isDemo: false, brandAliases: [], competitors: [], targetCountries: ['IN'], targetLanguages: ['en'],
      primaryKeywords: ['wedding invitation', 'digital invitation'],
    },
  },
}; // prettier-ignore

const capabilities = { interest: true, regions: true, relatedQueries: true, relatedTopics: true, subregions: true, maxKeywords: 5 }; // prettier-ignore
const provider = (p: Partial<TrendProviderStatusDto> & Pick<TrendProviderStatusDto, 'key' | 'label'>): TrendProviderStatusDto => ({
  kind: 'live', enabled: true, configured: false, available: false, experimental: false, paid: false, detail: 'Not set up.',
  capabilities, health: null, lastSuccessAt: null, lastFailure: null, ...p,
}); // prettier-ignore

function status(pytrends: Partial<TrendProviderStatusDto> = {}): TrendsStatusDto {
  return {
    providers: [
      provider({ key: 'PYTRENDS', label: 'Google Trends via pytrends (unofficial, experimental)', experimental: true, ...pytrends }), // prettier-ignore
      provider({ key: 'DATAFORSEO', label: 'Google Trends via DataForSEO (licensed, paid)', paid: true }),
      provider({ key: 'CSV_IMPORT', label: 'CSV exported from Google Trends', kind: 'import', configured: true, available: true, detail: 'Always available.' }), // prettier-ignore
    ],
    defaultProvider: pytrends.available ? 'PYTRENDS' : null,
    searchConsole: { connected: false, lastSyncedAt: null, detail: 'Connect Google Search Console.' },
    keywordPlanner: { configured: false, detail: 'Google Ads Keyword Planner is not connected.' },
    ai: { configured: true, detail: 'OpenAI' },
    limits: { liveReportsPerWorkspacePerDay: 30, liveReportsToday: 2, reportsPerProjectPerDay: 20 },
  };
}

const report: TrendReportDto = {
  id: 't1', projectId: 'p1', status: 'SUCCEEDED', source: 'PYTRENDS', sourceLabel: 'Google Trends via pytrends (unofficial, experimental)',
  sourceType: 'LIVE', experimental: true, keywords: ['wedding invitation', 'housewarming invitation'], country: 'IN', region: null, city: null,
  language: 'en', timeRange: 'past_90_days', category: 293, include: ['interest', 'regions', 'related_queries'], trigger: 'MANUAL',
  cached: false, partial: true, freshness: 'fresh', expiresAt: '2026-10-23T12:00:00.000Z', savedQueryId: null, imports: [],
  limitations: ['Related searches for “housewarming invitation” could not be fetched: Google Trends is rate-limiting requests from this server.', 'Values are relative interest from 0 to 100.'],
  exploreUrl: 'https://trends.google.com/explore?geo=IN&date=today%203-m&cat=293&q=wedding%2520invitation',
  data: {
    interest: {
      dates: ['2026-07-20', '2026-07-27'],
      series: [
        { keyword: 'wedding invitation', values: [54, 100], average: 77 },
        { keyword: 'housewarming invitation', values: [3, 5], average: 4 },
      ],
      partial: [false, true],
    },
    related: [{ keyword: 'wedding invitation', top: [{ query: 'wedding invitation card', value: 100 }], rising: [{ query: 'video invitation maker', value: 'Breakout' }] }],
    regions: { resolution: 'REGION', keywords: ['wedding invitation', 'housewarming invitation'], comparison: 'share', regions: [{ geoCode: 'IN-KL', name: 'Kerala', values: [97, 3] }] },
    topics: [],
  },
  analysis: {
    version: 1,
    terms: [
      { term: 'wedding invitation', origin: 'keyword', interest: 77, rising: null, direction: 'rising', status: 'present', matchedWords: [], missingWords: [], pages: [{ url: 'https://shubhlink.test/', title: 'Home', fields: ['title'] }], searchConsole: null },
      { term: 'video invitation maker', origin: 'rising_query', interest: null, rising: 'Breakout', direction: null, status: 'partial', matchedWords: [], missingWords: [], pages: [], searchConsole: null },
    ],
    placements: [
      { term: 'video invitation maker', action: 'add_to_page', pageUrl: 'https://shubhlink.test/', pageTitle: 'Home', section: 'Video Invitations', newSection: null, spot: 'heading', suggestedText: 'Video invitation maker for [your event]', reason: 'The homepage has a video section.' },
    ],
    method: { pagesChecked: 247, crawlFinishedAt: '2026-10-22T00:00:00.000Z', placementModel: 'gpt', searchConsole: { connected: false, rangeStart: null, rangeEnd: null } },
    notes: [],
  },
  fetchedAt: '2026-10-23T00:00:00.000Z',
  createdAt: '2026-10-23T00:00:00.000Z',
  finishedAt: '2026-10-23T00:00:30.000Z',
  errorMessage: null,
  jobId: 'j1',
}; // prettier-ignore

function renderTrends(
  routes: Record<string, MockResponse | ((init: RequestInit) => MockResponse)>,
  statusBody = status(),
) {
  // prettier-ignore
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({
    'GET /api/v1/auth/me': me,
    'GET /api/v1/projects/p1': project,
    'GET /api/v1/projects/p1/trends/status': { body: { data: statusBody } },
    'GET /api/v1/projects/p1/trends/categories': { body: { data: { source: 'test', categories: [[65, 'Hobbies & Leisure', ''], [293, 'Weddings', 'Hobbies & Leisure > Special Occasions'], [18, 'Shopping', '']] } } }, // prettier-ignore
    'GET /api/v1/projects/p1/trends/reports': { body: { data: [] } },
    'GET /api/v1/projects/p1/trends/saved': { body: { data: [] } },
    ...routes,
  });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path="trends" element={<TrendsPage />} />
      </Route>
    </Routes>,
    { route: '/app/p/p1/trends' },
  );
  return calls;
}

describe('TrendsPage', () => {
  it('shows trends with their source, what is missing, the site comparison and where to add terms', async () => {
    renderTrends({ 'GET /api/v1/projects/p1/trends/latest': { body: { data: report } } });
    expect(await screen.findByText(/Where to add them/)).toBeInTheDocument();
    expect(screen.getByText('Video Invitations', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Video invitation maker for [your event]')).toBeInTheDocument();
    expect(screen.getByText('Targeted')).toBeInTheDocument();
    expect(screen.getByText('Not targeted')).toBeInTheDocument();
    expect(screen.getAllByText('Breakout').length).toBeGreaterThan(0);
    // Source and partial data are stated, never hidden.
    expect(
      screen.getAllByText('Google Trends via pytrends (unofficial, experimental)').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Some of the requested data could not be fetched')).toBeInTheDocument();
    expect(screen.getByText(/rate-limiting requests from this server/)).toBeInTheDocument();
    expect(screen.getByText(/split between your terms/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Check on Google Trends/ })).toHaveAttribute(
      'href',
      report.exploreUrl,
    );
    // No live source is available: the button is disabled and the page says how to get real data.
    expect(screen.getByRole('button', { name: /Fetch live data/ })).toBeDisabled();
    expect(screen.getByText('No live data source is available')).toBeInTheDocument();
    expect(screen.getByText('Data sources')).toBeInTheDocument();
  });

  it('fetches live data from the available provider with the chosen region and data types', async () => {
    const calls = renderTrends(
      {
        'GET /api/v1/projects/p1/trends/latest': { body: { data: null } },
        'POST /api/v1/projects/p1/trends': { status: 202, body: { data: { reportId: 't3', jobId: 'j3', cached: false } } }, // prettier-ignore
        'GET /api/v1/projects/p1/trends/reports/t3': { body: { data: { ...report, id: 't3', status: 'QUEUED', analysis: null, jobId: 'j3' } } }, // prettier-ignore
        'GET /api/v1/jobs/j3': {
          body: { data: { id: 'j3', status: 'RUNNING', progress: 10, message: 'Fetching' } },
        },
      },
      status({ configured: true, available: true, detail: 'Experimental and free.' }),
    );
    const button = await screen.findByRole('button', { name: /Fetch live data/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.selectOptions(screen.getByLabelText(/^Region/), 'IN-GJ');
    await userEvent.click(screen.getByLabelText('Related topics'));
    await userEvent.click(button);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))).toBe(true),
    );
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))!.init.body)); // prettier-ignore
    expect(body).toMatchObject({
      keywords: ['wedding invitation', 'digital invitation'],
      country: 'IN',
      region: 'IN-GJ',
      include: ['interest', 'regions', 'related_queries'],
      suggestPlacements: true,
    });
  });

  it('previews CSV files exported from Google Trends before importing them', async () => {
    const calls = renderTrends({
      'GET /api/v1/projects/p1/trends/latest': { body: { data: null } },
      'POST /api/v1/projects/p1/trends/import': {
        status: 202,
        body: { data: { reportId: 't2', jobId: 'j2' } },
      },
    });
    expect(await screen.findByText('See what people search for in your field')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Google Trends/ })).toHaveAttribute(
      'href',
      'https://trends.google.com/explore?geo=IN&date=today%203-m&q=wedding%2520invitation%2Cdigital%2520invitation',
    );
    await userEvent.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog');
    const interest = new File(['Week,wedding invitation: (India)\n2026-07-20,54\n2026-07-27,100'], 'multiTimeline.csv', { type: 'text/csv' }); // prettier-ignore
    const other = new File(['name,email\nA,a@example.test'], 'contacts.csv', { type: 'text/csv' });
    await userEvent.upload(within(dialog).getByLabelText('CSV files exported from Google Trends'), [
      interest,
      other,
    ]);
    expect(await within(dialog).findByText('Interest over time')).toBeInTheDocument();
    expect(within(dialog).getByText('Not recognised')).toBeInTheDocument();
    // Nothing is sent until the user confirms.
    expect(calls.some((c) => c.path.endsWith('/trends/import'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: /Import 1 file/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/trends/import'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/trends/import'))!.init.body));
    expect(body).toMatchObject({ country: 'IN', timeRange: 'past_90_days', suggestPlacements: true });
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(['multiTimeline.csv', 'contacts.csv']);
  });

  it('searches Google Trends categories and sends the chosen one', async () => {
    const calls = renderTrends(
      {
        'GET /api/v1/projects/p1/trends/latest': { body: { data: null } },
        'POST /api/v1/projects/p1/trends': { status: 202, body: { data: { reportId: 't4', jobId: 'j4', cached: false } } }, // prettier-ignore
        'GET /api/v1/projects/p1/trends/reports/t4': { body: { data: { ...report, id: 't4', status: 'QUEUED', analysis: null, jobId: 'j4' } } }, // prettier-ignore
        'GET /api/v1/jobs/j4': {
          body: { data: { id: 'j4', status: 'RUNNING', progress: 10, message: 'Fetching' } },
        },
      },
      status({ configured: true, available: true, detail: 'Experimental and free.' }),
    );
    const category = await screen.findByRole('combobox', { name: /Category/ });
    // Focus shows the top-level categories; typing filters them.
    await userEvent.click(category);
    const list = await screen.findByRole('listbox', { name: 'Google Trends categories' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'All categoriesNo category filter',
      'Hobbies & LeisureTop level · id 65',
      'ShoppingTop level · id 18',
    ]);
    await userEvent.type(category, 'wed');
    await userEvent.click(screen.getByRole('option', { name: /Weddings/ }));
    expect(category).toHaveValue('Weddings (293)');
    expect(screen.getByText('In Hobbies & Leisure > Special Occasions.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Fetch live data/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))).toBe(true),
    );
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))!.init.body)); // prettier-ignore
    expect(body.category).toBe(293);
  });

  it('says why a configured live source cannot be used', async () => {
    renderTrends(
      { 'GET /api/v1/projects/p1/trends/latest': { body: { data: null } } },
      status({
        configured: true,
        available: false,
        health: { ok: false, coolingDownSeconds: 0, lastError: 'The service token does not match PYTRENDS_SERVICE_TOKEN.', checkedAt: '2026-10-23T11:00:00.000Z' }, // prettier-ignore
      }),
    );
    expect(await screen.findByText('A live data source is set up but not reachable')).toBeInTheDocument();
    // In the alert above the button, and in the Data sources panel.
    expect(screen.getAllByText(/The service token does not match/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Fetch live data/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Check again/ })).toBeEnabled();
  });

  it('filters by city with searches that mention it, measured in the city’s state', async () => {
    const calls = renderTrends(
      {
        'GET /api/v1/projects/p1/trends/latest': { body: { data: null } },
        'POST /api/v1/projects/p1/trends': { status: 202, body: { data: { reportId: 't5', jobId: 'j5', cached: false } } }, // prettier-ignore
        'GET /api/v1/projects/p1/trends/reports/t5': { body: { data: { ...report, id: 't5', status: 'QUEUED', analysis: null, jobId: 'j5' } } }, // prettier-ignore
        'GET /api/v1/jobs/j5': {
          body: { data: { id: 'j5', status: 'RUNNING', progress: 10, message: 'Fetching' } },
        },
      },
      status({ configured: true, available: true, detail: 'Experimental and free.' }),
    );
    const city = await screen.findByRole('combobox', { name: /City/ });
    await userEvent.type(city, 'sur');
    await userEvent.click(screen.getByRole('option', { name: /^Surat/ }));
    expect(city).toHaveValue('Surat');
    // A known city sets its state, and the page says what will be compared.
    expect(screen.getByLabelText(/^Region/)).toHaveValue('IN-GJ');
    expect(screen.getByText(/Will compare: “wedding invitation surat”, “digital invitation surat”/)).toBeInTheDocument(); // prettier-ignore
    expect(screen.getByRole('link', { name: /Open in Google Trends/ })).toHaveAttribute('href', expect.stringContaining('geo=IN-GJ')); // prettier-ignore
    await userEvent.click(screen.getByRole('button', { name: /Fetch live data/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))).toBe(true),
    );
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/trends'))!.init.body)); // prettier-ignore
    expect(body).toMatchObject({ keywords: ['wedding invitation', 'digital invitation'], country: 'IN', region: 'IN-GJ', city: 'Surat' }); // prettier-ignore

    // A state that does not contain the city clears it; a city not in the list can be typed.
    await userEvent.selectOptions(screen.getByLabelText(/^Region/), 'IN-MH');
    expect(city).toHaveValue('');
    await userEvent.type(city, 'Navsari');
    await userEvent.tab();
    expect(city).toHaveValue('Navsari');
    expect(screen.getByLabelText(/^Region/)).toHaveValue('IN-MH');
  });
});
