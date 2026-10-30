import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { MerchantStatusDto, ProductDto, ProductFeedPreviewDto } from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import MerchantPage from '@/pages/app/merchant';
import { mockFetch, renderWithProviders, type MockResponse } from './utils';

const me = (role: 'OWNER' | 'CLIENT') => ({
  body: {
    data: {
      user: {
        id: 'u1',
        email: 'owner@example.test',
        name: 'Owner',
        emailVerified: true,
        platformRole: 'USER',
      },
      memberships: [{ workspaceId: 'w1', workspaceName: 'WS', workspaceSlug: 'ws', role, via: 'DIRECT', agencyWorkspaceId: null, approvalsDelegated: false }], // prettier-ignore
      currentWorkspaceId: 'w1',
    },
  },
});
const project = {
  body: {
    data: {
      id: 'p1', workspaceId: 'w1', name: 'Navkar Jewellers', websiteUrl: 'https://navkar.example.in/', domain: 'navkar.example.in', isDemo: false, brandAliases: [], competitors: [],
      targetCountries: ['IN'], targetLanguages: ['en'], primaryKeywords: [],
    },
  },
}; // prettier-ignore

const status = (over: Partial<MerchantStatusDto> = {}): MerchantStatusDto => ({
  configured: true,
  setup: 'Needs OAuth verification and developer registration.',
  plan: { ecommerce: true, productsTracked: 5000, productsUsed: 2 },
  integration: null,
  account: null,
  products: { total: 2, errors: 1, warnings: 0, ok: 1, bySource: { FEED_IMPORT: 2 }, blockedByProgram: { FREE_LISTINGS: 1, SHOPPING_ADS: 1, FREE_LOCAL_LISTINGS: 1 }, topIssues: [{ code: 'currency_mismatch', message: 'The price is in USD, but products sold in IN need INR.', severity: 'error', products: 1 }] }, // prettier-ignore
  lastImport: { id: 'imp1', fileName: 'feed.csv', createdAt: '2026-10-24T08:00:00Z', products: 2 },
  hasWebsite: true,
  checklist: [
    { key: 'account', title: 'Merchant Center account', status: 'todo', detail: 'The business has an account: connect it to see Google’s product statuses.', action: { label: 'Connect', href: '#connect', external: false } }, // prettier-ignore
    {
      key: 'products',
      title: 'Products submitted',
      status: 'done',
      detail: '2 products (2 from a feed file).',
      action: null,
    },
    { key: 'free_listings', title: 'Free listings turned on', status: 'unknown', detail: 'Connect Merchant Center to check whether free listings are on.', action: null }, // prettier-ignore
  ],
  limitations: ['Free listings, Shopping ads and free local listings are checked separately.'],
  ...over,
});

const product: ProductDto = {
  id: 'mp1', source: 'FEED_IMPORT', contentLanguage: 'en', feedLabel: 'IN', offerId: 'R-2', title: 'Navkar Gold Ring 2', description: 'A ring', link: 'https://navkar.example.in/p/r-2',
  imageLink: null, additionalImageLinks: [], price: { amount: 15002, currency: 'USD' }, salePrice: null, availability: 'in_stock', condition: null, brand: 'Navkar', gtins: [], mpn: null,
  identifierExists: false, googleProductCategory: '188', productTypes: [], itemGroupId: null, color: 'yellow', material: '22k gold', pattern: null, size: null, gender: 'female', ageGroup: 'adult',
  productDetails: [], status: 'errors', errorCount: 1, warningCount: 0, googleStatus: null, lastSeenAt: '2026-10-24T08:00:00Z', updatedAt: '2026-10-24T08:00:00Z',
  issues: [{ code: 'currency_mismatch', severity: 'error', attribute: 'price', message: 'The price is in USD, but products sold in IN need INR.', fix: 'Submit prices in INR, or set up currency conversion in Merchant Center.', programs: ['FREE_LISTINGS', 'SHOPPING_ADS', 'FREE_LOCAL_LISTINGS'], source: 'SURFACED', countries: ['IN'], documentation: null }],
}; // prettier-ignore

const preview: ProductFeedPreviewDto = {
  format: 'GOOGLE_CSV', rows: 1, products: 1, columns: [{ name: 'id', mappedTo: 'offerId' }], ignoredColumns: ['internal_note'], rowErrors: [],
  sample: [{ ...product, issues: [] }], summary: { errors: 0, warnings: 0, ok: 1 }, limitations: ['Merchant Center makes the final decision.'],
}; // prettier-ignore

function renderPage(
  role: 'OWNER' | 'CLIENT',
  routes: Record<string, MockResponse | ((init: RequestInit) => MockResponse)>,
) {
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({
    'GET /api/v1/auth/me': me(role),
    'GET /api/v1/projects/p1': project,
    'GET /api/v1/projects/p1/merchant/products': { body: { data: [product], meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 } } }, // prettier-ignore
    ...routes,
  });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path="local/merchant" element={<MerchantPage />} />
      </Route>
    </Routes>,
    { route: '/app/p/p1/local/merchant' },
  );
  return calls;
}

describe('Merchant Center page', () => {
  it('shows the checklist and product issues with their fix and the programs they affect', async () => {
    renderPage('OWNER', { 'GET /api/v1/projects/p1/merchant': { body: { data: status() } } });
    expect(await screen.findByText('What your products need to appear on Google')).toBeInTheDocument();
    expect(screen.getByText(/connect it to see Google’s product statuses/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 likely blocked/)).toHaveLength(3);
    await userEvent.click(await screen.findByRole('button', { name: 'Issues of Navkar Gold Ring 2' }));
    expect(
      screen.getByText('Submit prices in INR, or set up currency conversion in Merchant Center.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Surfaced check').length).toBeGreaterThan(0);
  });

  it('checks a file before importing it', async () => {
    const calls = renderPage('OWNER', {
      'GET /api/v1/projects/p1/merchant': { body: { data: status() } },
      'POST /api/v1/projects/p1/merchant/import/preview': { body: { data: preview } },
      'POST /api/v1/projects/p1/merchant/import': { body: { data: { importId: 'i2', imported: 1, updated: 0, removed: 0, skipped: 0, rowErrors: [], limitedByPlan: false } } }, // prettier-ignore
    });
    const input = await screen.findByLabelText('Feed file');
    await userEvent.upload(
      input,
      new File(['id,title,price\nR-9,Ring,999 INR\n'], 'feed.csv', { type: 'text/csv' }),
    );
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText(/Columns not read: internal_note/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Import 1 products/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/projects/p1/merchant/import')).toBe(true)); // prettier-ignore
    const body = JSON.parse(
      String(calls.find((c) => c.path === '/api/v1/projects/p1/merchant/import')!.init.body),
    );
    expect(body).toMatchObject({ fileName: 'feed.csv', country: 'IN', language: 'en', mode: 'replace', content: 'id,title,price\nR-9,Ring,999 INR\n' }); // prettier-ignore
  });

  it('lets a client view but not import, and explains the plan when it lacks product feeds', async () => {
    renderPage('CLIENT', { 'GET /api/v1/projects/p1/merchant': { body: { data: status({ plan: { ecommerce: false, productsTracked: 0, productsUsed: 0 } }) } } }); // prettier-ignore
    expect(await screen.findByText('Your plan does not include product feeds')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import/ })).not.toBeInTheDocument();
    const products = screen.getByText('Products', { selector: 'h2' }).closest('section')!;
    expect(within(products).queryByRole('button', { name: /Remove imported/ })).not.toBeInTheDocument();
  });
});
