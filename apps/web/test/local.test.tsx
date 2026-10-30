import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { LocalOverviewDto, LocalRankQueryDto, LocalRankScanDto, LocationDto } from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import LocalOverviewPage from '@/pages/app/local-overview';
import NewProjectPage from '@/pages/app/project-new';
import RankTrackerPage from '@/pages/app/rank-tracker';
import { mockFetch, renderWithProviders, type MockResponse } from './utils';

// Leaflet needs a real browser; the grid is also shown as an accessible table, which these tests use.
vi.mock('@/components/local/rank-map', () => ({ default: () => <div data-testid="rank-map" /> }));
// The location editor's draggable pin map is also Leaflet-based.
vi.mock('@/components/local/location-pin-map', () => ({ default: () => <div data-testid="pin-map" /> }));

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
      memberships: [{ workspaceId: 'w1', workspaceName: 'WS', workspaceSlug: 'ws', role: 'OWNER', via: 'DIRECT', agencyWorkspaceId: null, approvalsDelegated: false }], // prettier-ignore
      currentWorkspaceId: 'w1',
    },
  },
};

const project = {
  body: {
    data: {
      id: 'p1', workspaceId: 'w1', name: 'Navkar Jewellers', websiteUrl: null, domain: null, isDemo: false, brandAliases: [], competitors: [],
      targetCountries: ['IN'], targetLanguages: ['en'], primaryKeywords: [],
    },
  },
}; // prettier-ignore

const location: LocationDto = {
  id: 'l1', projectId: 'p1', name: 'Navkar Jewellers', kind: 'STOREFRONT', primaryCategory: 'Jewellery store', secondaryCategories: [],
  addressLine1: 'Ghod Dod Road', addressLine2: null, locality: 'Athwa', city: 'Surat', region: 'Gujarat', postalCode: '395007', country: 'IN',
  serviceAreas: [], latitude: 21.1702, longitude: 72.8311, phone: null, email: null, websiteUrl: null, openingHours: [], isPrimary: true,
  source: 'MANUAL', profileLocationName: null, placeId: null, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
}; // prettier-ignore

function renderInProject(
  page: React.ReactNode,
  path: string,
  routes: Record<string, MockResponse | ((init: RequestInit) => MockResponse)>,
) {
  // prettier-ignore
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({ 'GET /api/v1/auth/me': me, 'GET /api/v1/projects/p1': project, ...routes });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path={path} element={page} />
      </Route>
    </Routes>,
    { route: `/app/p/p1/${path}` },
  );
  return calls;
}

describe('onboarding without a website', () => {
  it('creates a local business with a location and goes to the local dashboard', async () => {
    document.cookie = 'sf_csrf=t';
    const calls = mockFetch({
      'GET /api/v1/auth/me': me,
      'POST /api/v1/projects': { status: 201, body: { data: { ...project.body.data, id: 'p9' } } },
    });
    renderWithProviders(<NewProjectPage />, { route: '/app/projects/new' });
    await userEvent.type(await screen.findByLabelText('Business name'), 'Navkar Jewellers');
    await userEvent.click(screen.getByLabelText('This business has no website'));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(await screen.findByLabelText('Local business with premises customers visit'));
    await userEvent.selectOptions(screen.getByLabelText('Google Business Profile'), 'NONE');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    // A local business gets the location step switched on, with the name filled in.
    expect(screen.getByLabelText('Name customers see')).toHaveValue('Navkar Jewellers');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter the street address customers visit')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Street address'), 'Shop 4, Ghod Dod Road');
    await userEvent.type(screen.getByLabelText('City'), 'Surat');
    await userEvent.type(screen.getByLabelText(/^Coordinates/), '21.1702, 72.8311');
    await userEvent.click(screen.getByLabelText('Open on Monday'));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    // The plan separates what works without a website.
    expect(await screen.findByText('Works without a website')).toBeInTheDocument();
    expect(screen.getByText(/You have no Business Profile yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Run the first audit now')).not.toBeInTheDocument();
    // Reaching the review step must not submit the form (the Next button is not reused as the submit button).
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/projects')).toBe(true),
    );
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/projects')!.init.body)); // prettier-ignore
    expect(body).toMatchObject({
      name: 'Navkar Jewellers',
      websiteUrl: null,
      targetCountries: ['IN'],
      businessProfile: { types: ['LOCAL_STOREFRONT'], profilePresence: 'NONE' },
      locations: [{ name: 'Navkar Jewellers', city: 'Surat', country: 'IN', latitude: 21.1702, longitude: 72.8311, addressLine1: 'Shop 4, Ghod Dod Road', openingHours: [{ day: 'MONDAY', open: '10:00', close: '19:00' }] }], // prettier-ignore
    });
    expect(calls.some((c) => c.path.endsWith('/audits'))).toBe(false);
    await waitFor(() => expect(screen.getByTestId('current-location')).toHaveTextContent('/app/p/p9/local'));
  });
});

const overview: LocalOverviewDto = {
  generatedAt: '2026-10-23T10:00:00Z',
  days: 28,
  location: { id: 'l1', name: 'Navkar Jewellers', city: 'Surat' },
  hasWebsite: false,
  cards: [
    { key: 'maps', title: 'Google Maps / local pack visibility', state: 'ok', value: '50%', previous: '37.5%', change: { absolute: '+12.5 pts', percent: 33.3, direction: 'up', good: true }, dateRange: 'Scan of 2026-10-23 vs 2026-10-16', place: 'Athwa, Surat', source: 'Your own collection service', lastCollectedAt: '2026-10-23T09:00:00Z', freshness: 'fresh', limitations: ['Share of measured grid points where the business is in the top 3.'], lines: [{ label: 'best jewellers in surat (Maps)', value: '50%', note: '8/9 points measured' }], action: { label: 'Open the rank tracker', to: '/app/p/p1/local/rank' } }, // prettier-ignore
    { key: 'organic', title: 'Google organic search', state: 'unsupported', value: null, previous: null, change: null, dateRange: null, place: null, source: null, lastCollectedAt: null, freshness: null, limitations: ['Organic search performance needs a website and Search Console.'], lines: [], action: null }, // prettier-ignore
    { key: 'business_profile', title: 'Business Profile performance', state: 'connect', value: null, previous: null, change: null, dateRange: null, place: null, source: null, lastCollectedAt: null, freshness: null, limitations: [], lines: [], action: { label: 'Connect account', to: '/app/p/p1/integrations' } }, // prettier-ignore
  ],
  setup: [
    { key: 'location', title: 'Add the map position of Navkar Jewellers', detail: 'Rank grids need its latitude and longitude.', status: 'done', fills: ['Google Maps / local pack visibility'], action: { label: 'Edit the location', to: '/app/p/p1/locations' } }, // prettier-ignore
    { key: 'ai_mode', title: 'Record what Google AI Mode shows', detail: 'Google has no API for AI Mode.', status: 'todo', fills: ['Google AI Mode / AI Overviews'], action: { label: 'Open observations', to: '/app/p/p1/visibility?tab=observations' } }, // prettier-ignore
    { key: 'business_profile', title: 'Connect Google Business Profile', detail: 'Needs a Google OAuth client.', status: 'admin', fills: ['Business Profile performance'], action: { label: 'Open Business Profile', to: '/app/p/p1/local/profile' } }, // prettier-ignore
  ],
};

describe('Local Search & AI Visibility', () => {
  it('shows each surface separately with its source, change and missing-data states', async () => {
    renderInProject(<LocalOverviewPage />, 'local', {
      'GET /api/v1/projects/p1/locations': { body: { data: [location] } },
      'GET /api/v1/projects/p1/local/overview': { body: { data: overview } },
    });
    expect(await screen.findByText('Google Maps / local pack visibility')).toBeInTheDocument();
    expect(screen.getByText('+12.5 pts (+33.3%)')).toBeInTheDocument();
    expect(screen.getByText('Your own collection service')).toBeInTheDocument();
    expect(screen.getByText('Measurement unsupported')).toBeInTheDocument();
    expect(screen.getAllByText('Connect account').length).toBeGreaterThan(0);
    // The setup steps say what to do next and what needs an administrator.
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.getByText(/Next: record what google ai mode shows/)).toBeInTheDocument();
    expect(screen.getByText('Needs administrator setup')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open observations/ })).toHaveAttribute(
      'href',
      '/app/p/p1/visibility?tab=observations',
    );
    expect(screen.getByRole('link', { name: /Open the rank tracker/ })).toHaveAttribute(
      'href',
      '/app/p/p1/local/rank',
    );
  });
});

const query: LocalRankQueryDto = {
  id: 'q1', locationId: 'l1', query: 'best jewellers in surat', surface: 'MAPS', language: 'en', device: 'mobile', gridSize: 1, spacingKm: 1, depth: 20,
  centerLatitude: 21.1702, centerLongitude: 72.8311, frequency: 'MANUAL', nextRunAt: null, status: 'ACTIVE', latestScan: null, createdAt: '2026-10-23T00:00:00Z',
}; // prettier-ignore

const manualScan: LocalRankScanDto = {
  id: 's1', queryId: 'q1', source: 'MANUAL', status: 'RUNNING', trigger: 'MANUAL', costUsd: null, createdAt: '2026-10-23T09:00:00Z', finishedAt: null,
  summary: { pointsPlanned: 1, pointsMeasured: 0, pointsFailed: 0, coverage: 0, top3: 0, top10: 0, notFound: 0, top3Share: null, top10Share: null, averageRankFound: null },
  query: 'best jewellers in surat', surface: 'MAPS', language: 'en', device: 'mobile', gridSize: 1, spacingKm: 1, depth: 20, centerLatitude: 21.1702, centerLongitude: 72.8311,
  points: [{ row: 0, col: 0, latitude: 21.1702, longitude: 72.8311, status: 'PENDING', rank: null, error: null, results: [] }],
  observationType: 'observed_search_position', collectionStatus: 'in_progress', captureBatches: null, captureProgress: null, limitations: [], errorMessage: null, jobId: null,
}; // prettier-ignore

describe('Local Rank Tracker', () => {
  it('records a manual observation at a grid point, labeled as manual', async () => {
    const calls = renderInProject(<RankTrackerPage />, 'local/rank', {
      'GET /api/v1/projects/p1/locations': { body: { data: [location] } },
      'GET /api/v1/projects/p1/local/status': { body: { data: { sources: [{ key: 'CUSTOM', label: 'Your own collection service', live: true, configured: false, available: false, detail: 'Not enabled.' }, { key: 'MANUAL', label: 'Manual observation', live: false, configured: true, available: true, detail: '' }], defaultLiveSource: null, usage: { localRankPoints: { used: 0, limit: 500, periodKey: '2026-10' } }, locations: { used: 1, limit: 3 }, hasWebsite: false, compliance: 'Google offers no API for Maps rankings.' } } }, // prettier-ignore
      'GET /api/v1/projects/p1/local/queries': { body: { data: [query] } },
      'POST /api/v1/projects/p1/local/queries/q1/scans': { status: 202, body: { data: { scanId: 's1', jobId: null, status: 'QUEUED' } } }, // prettier-ignore
      'GET /api/v1/projects/p1/local/queries/q1/scans': { body: { data: [] } },
      'GET /api/v1/projects/p1/local/scans/s1': { body: { data: manualScan } },
      'GET /api/v1/projects/p1/local/queries/q1/comparison': { body: { data: { scanId: null, measured: 0, showings: [], reviewGrowth: {} } } }, // prettier-ignore
      'POST /api/v1/projects/p1/local/scans/s1/points': { body: { data: { rank: 2 } } },
    });
    expect(await screen.findByText('No live rank source is connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Scan now/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Record manually/ }));
    const cell = await screen.findByRole('button', { name: /Point 1-1: Not measured yet/ });
    expect(screen.getByText('Manual observation (entered by a person)')).toBeInTheDocument();
    await userEvent.click(cell);
    await userEvent.type(
      screen.getByLabelText('Businesses in the order shown'),
      '1. Kalamandir Jewellers{enter}2. Navkar Jewellers Athwa',
    );
    await userEvent.click(screen.getByLabelText('Navkar Jewellers Athwa is my business'));
    await userEvent.click(screen.getByRole('button', { name: 'Save this point' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/scans/s1/points'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/scans/s1/points'))!.init.body));
    expect(body).toEqual({ row: 0, col: 0, results: [{ title: 'Kalamandir Jewellers', isTarget: false }, { title: 'Navkar Jewellers Athwa', isTarget: true }] }); // prettier-ignore
    const table = screen.getByRole('table', { name: 'Grid points (table view)' });
    expect(within(table).getAllByRole('button')).toHaveLength(1);
  });
});
