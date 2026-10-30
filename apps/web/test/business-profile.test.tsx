import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  BusinessProfileLocationDto,
  BusinessProfileStatusDto,
  BusinessReviewDto,
  ReviewReplyDto,
} from '@surfaced/shared';
import { ProjectScope } from '@/app/project-scope';
import BusinessProfilePage from '@/pages/app/business-profile';
import { mockFetch, renderWithProviders, type MockResponse } from './utils';

const me = (role: 'OWNER' | 'MEMBER') => ({
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
      id: 'p1', workspaceId: 'w1', name: 'Navkar Jewellers', websiteUrl: null, domain: null, isDemo: false, brandAliases: [], competitors: [],
      targetCountries: ['IN'], targetLanguages: ['en'], primaryKeywords: [],
    },
  },
}; // prettier-ignore

const status = (linked: boolean, connected = true): BusinessProfileStatusDto => ({
  configured: true,
  setup: 'Google must approve the Cloud project first.',
  retentionDays: 30,
  integration: connected
    ? { id: 'i1', status: 'CONNECTED', externalAccount: 'owner@example.test', connectedAt: '2026-10-20T00:00:00Z', lastSyncAt: '2026-10-24T06:00:00Z', lastSyncStatus: 'SUCCEEDED', lastError: null } // prettier-ignore
    : null,
  locations: [
    { id: 'l1', name: 'Navkar Jewellers', city: 'Surat', kind: 'STOREFRONT', profileLocationName: linked ? 'locations/111' : null, profileAccountName: linked ? 'accounts/9' : null, snapshotAt: linked ? '2026-10-24T06:00:00Z' : null, unansweredReviews: 1 }, // prettier-ignore
  ],
});

const approvedDraft: ReviewReplyDto = {
  id: 'rr1', reviewName: 'accounts/9/locations/111/reviews/r1', comment: 'Sorry for the wait, Asha. Please call us.', origin: 'AI', model: 'dev-template',
  status: 'AWAITING_APPROVAL', approval: { id: 'a1', status: 'APPROVED', coversCurrentText: true }, canPublish: true, publishedAt: null, publishError: null,
  createdBy: { id: 'u1', name: 'Owner' }, createdAt: '2026-10-24T07:00:00Z', updatedAt: '2026-10-24T07:00:00Z',
}; // prettier-ignore

const reviews: BusinessReviewDto[] = [
  { id: 'br1', reviewName: approvedDraft.reviewName, reviewerName: 'Asha Patel', isAnonymous: false, starRating: 2, comment: 'Waited 40 minutes', createTime: '2026-10-20T10:00:00Z', updateTime: null, reply: null, fetchedAt: '2026-10-24T06:00:00Z', draft: approvedDraft }, // prettier-ignore
  { id: 'br2', reviewName: 'accounts/9/locations/111/reviews/r2', reviewerName: null, isAnonymous: true, starRating: 5, comment: null, createTime: '2026-10-19T10:00:00Z', updateTime: null, reply: { comment: 'Thank you!', updateTime: null }, fetchedAt: '2026-10-24T06:00:00Z', draft: null }, // prettier-ignore
  { id: 'br3', reviewName: 'accounts/9/locations/111/reviews/r3', reviewerName: 'Ravi', isAnonymous: false, starRating: 4, comment: 'Nice designs', createTime: '2026-10-18T10:00:00Z', updateTime: null, reply: null, fetchedAt: '2026-10-24T06:00:00Z', draft: null }, // prettier-ignore
];

const detail = (linked: boolean): BusinessProfileLocationDto => ({
  location: { id: 'l1', name: 'Navkar Jewellers', city: 'Surat', kind: 'STOREFRONT', profileLocationName: linked ? 'locations/111' : null, profileAccountName: linked ? 'accounts/9' : null }, // prettier-ignore
  profile: linked
    ? {
        name: 'locations/111', title: 'Navkar Jewellers', storeCode: null, primaryCategory: 'Jewelry store', additionalCategories: [], primaryPhone: '+91 261 000 0000',
        additionalPhones: [], websiteUri: null, address: { lines: ['Shop 4, Ghod Dod Road'], sublocality: null, locality: 'Surat', administrativeArea: null, postalCode: '395007', regionCode: 'IN' },
        serviceArea: null, regularHours: [{ day: 'MONDAY', open: '10:00', close: '20:00' }], specialHoursCount: 0, description: null, openStatus: 'OPEN', latitude: null, longitude: null,
        placeId: 'ChIJ-navkar', mapsUri: 'https://maps.google.com/?cid=1', newReviewUri: null, hasVoiceOfMerchant: true, hasPendingEdits: false, hasGoogleUpdated: false, labels: [],
      } // prettier-ignore
    : null,
  snapshotAt: linked ? '2026-10-24T06:00:00Z' : null,
  reviewTotals: linked ? { averageRating: 3.7, totalReviewCount: 3 } : null,
  audit: {
    source: linked ? 'BUSINESS_PROFILE' : 'MANUAL',
    checkedAt: '2026-10-24T08:00:00Z',
    applicable: 3,
    passed: 2,
    checks: [
      { key: 'review_replies', title: 'Reviews are answered', status: 'fail', severity: 'warning', evidence: '2 of the 3 most recent reviews have no reply.', recommendation: 'Reply to reviews, especially critical ones.', verification: 'The reply shows under the review on Google.', reference: 'https://support.google.com/business/answer/3474050' }, // prettier-ignore
      { key: 'primary_category', title: 'Primary category is set', status: 'pass', severity: 'critical', evidence: 'Primary category: Jewelry store.', recommendation: null, verification: null, reference: null }, // prettier-ignore
      { key: 'website', title: 'Website is linked', status: 'not_applicable', severity: 'warning', evidence: 'The business has no website, so this check does not apply and is not counted.', recommendation: null, verification: null, reference: null }, // prettier-ignore
    ],
    limitations: ['Checks follow Google’s published guidelines; passing them does not guarantee rankings.'],
  },
  metrics: linked
    ? {
        range: { from: '2026-09-24', to: '2026-10-21' }, previousRange: null,
        metrics: [
          { metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', label: 'Views on Google Maps (mobile)', current: 40, previous: null, changePercent: null },
          { metric: 'CALL_CLICKS', label: 'Call button clicks', current: 5, previous: null, changePercent: null },
        ],
        daily: [{ date: '2026-10-20', maps: 40, search: 0, actions: 3 }, { date: '2026-10-21', maps: 0, search: 0, actions: 2 }],
        fetchedAt: '2026-10-24T06:00:00Z',
        limitations: ['Fewer than 56 days of data: no comparison with the previous period yet.'],
      } // prettier-ignore
    : null,
  reviews: linked ? reviews : [],
  unansweredReviews: linked ? 2 : 0,
  reviewSummary: null,
  profileChange: null,
  limitations: ['Google allows Business Profile data to be stored for at most 30 days.'],
});

function renderPage(
  role: 'OWNER' | 'MEMBER',
  routes: Record<string, MockResponse | ((init: RequestInit) => MockResponse)>,
) {
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({ 'GET /api/v1/auth/me': me(role), 'GET /api/v1/projects/p1': project, ...routes });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path="local/profile" element={<BusinessProfilePage />} />
      </Route>
    </Routes>,
    { route: '/app/p/p1/local/profile' },
  );
  return calls;
}

describe('Business Profile page', () => {
  it('shows the audit with its evidence, Google’s numbers and reviews, and publishes an approved reply after confirming', async () => {
    const calls = renderPage('OWNER', {
      'GET /api/v1/projects/p1/business-profile': { body: { data: status(true) } },
      'GET /api/v1/projects/p1/locations/l1/business-profile': { body: { data: detail(true) } },
      'POST /api/v1/projects/p1/review-replies/rr1/publish': { body: { data: { ...approvedDraft, status: 'PUBLISHED', canPublish: false } } }, // prettier-ignore
    });
    expect(await screen.findByText(/2 of 3 applicable checks pass/)).toBeInTheDocument();
    expect(screen.getByText('Reply to reviews, especially critical ones.')).toBeInTheDocument();
    expect(screen.getByText(/does not apply and is not counted/)).toBeInTheDocument();
    expect(screen.getByText('Live profile from Google')).toBeInTheDocument();
    expect(screen.getByText('Profile views').closest('section')).toHaveTextContent('40');
    expect(screen.getByText(/3\.7 from\s+3 reviews \(as Google reports\)/)).toBeInTheDocument();

    // The development template is never presented as AI output.
    const review = screen.getByText('Waited 40 minutes').closest('section')!;
    expect(within(review).getByText('Development template (not AI-generated)')).toBeInTheDocument();
    await userEvent.click(within(review).getByRole('button', { name: /Publish to Google/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(calls.some((c) => c.path.endsWith('/publish'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/review-replies/rr1/publish'))).toBe(true)); // prettier-ignore
  });

  it('lets a member draft with guidance but not publish', async () => {
    const calls = renderPage('MEMBER', {
      'GET /api/v1/projects/p1/business-profile': { body: { data: status(true) } },
      'GET /api/v1/projects/p1/locations/l1/business-profile': { body: { data: detail(true) } },
      'POST /api/v1/projects/p1/reviews/br3/replies': { status: 201, body: { data: { ...approvedDraft, id: 'rr2', reviewName: reviews[2]!.reviewName, status: 'DRAFT', approval: null, canPublish: false } } }, // prettier-ignore
    });
    const asha = (await screen.findByText('Waited 40 minutes')).closest('section')!;
    expect(within(asha).queryByRole('button', { name: /Publish to Google/ })).not.toBeInTheDocument();
    expect(within(asha).getByText(/An owner or admin can publish it/)).toBeInTheDocument();

    const ravi = screen.getByText('Nice designs').closest('section')!;
    await userEvent.type(within(ravi).getByLabelText('Guidance for the AI draft'), 'Invite them back');
    await userEvent.click(within(ravi).getByRole('button', { name: /Draft a reply/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/reviews/br3/replies'))).toBe(true)); // prettier-ignore
    const body = JSON.parse(String(calls.find((c) => c.path.endsWith('/reviews/br3/replies'))!.init.body));
    expect(body).toEqual({ generate: true, instructions: 'Invite them back' });
  });

  it('without a connection, audits the entered details and offers to connect', async () => {
    renderPage('OWNER', {
      'GET /api/v1/projects/p1/business-profile': { body: { data: status(false, false) } },
      'GET /api/v1/projects/p1/locations/l1/business-profile': { body: { data: detail(false) } },
    });
    expect(await screen.findByRole('button', { name: /Connect with Google/ })).toBeInTheDocument();
    expect(await screen.findByText('Details entered in Surfaced')).toBeInTheDocument();
    expect(screen.getByText(/Google must approve Business Profile API access/)).toBeInTheDocument();
    expect(screen.queryByText('Reviews')).not.toBeInTheDocument();
  });
});
