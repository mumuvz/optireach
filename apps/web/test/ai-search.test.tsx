import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ProjectScope } from '@/app/project-scope';
import { ManualObservationDialog } from '@/components/app/manual-observation-dialog';
import ObservationPage from '@/pages/app/observation';
import type { PromptDto } from '@/lib/types';
import { mockFetch, renderWithProviders } from './utils';

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
      id: 'p1', workspaceId: 'w1', name: 'Navkar Jewellers', websiteUrl: 'https://navkar.example.in/', domain: 'navkar.example.in', isDemo: false, brandAliases: [], competitors: [],
      targetCountries: ['IN'], targetLanguages: ['en'], primaryKeywords: [],
    },
  },
}; // prettier-ignore
const prompt: PromptDto = {
  id: 'pr1', projectId: 'p1', text: 'Which are the best jewellers in Surat?', intent: null, country: 'IN', city: 'Surat', language: 'en', targetBrand: 'Navkar Jewellers',
  competitorIds: [], providers: ['mock_demo'], frequency: 'MANUAL', status: 'ACTIVE', lastRunAt: null, nextRunAt: null, createdAt: '2026-10-24T00:00:00Z',
}; // prettier-ignore

function inProject(
  element: React.ReactNode,
  path: string,
  route: string,
  routes: Parameters<typeof mockFetch>[0],
) {
  document.cookie = 'sf_csrf=t';
  const calls = mockFetch({ 'GET /api/v1/auth/me': me, 'GET /api/v1/projects/p1': project, ...routes });
  renderWithProviders(
    <Routes>
      <Route path="/app/p/:projectId" element={<ProjectScope />}>
        <Route path={path} element={element} />
      </Route>
    </Routes>,
    { route },
  );
  return calls;
}

describe('manual AI observations', () => {
  it('sends the pasted answer with its links, the surface and the prompt city', async () => {
    const calls = inProject(<ManualObservationDialog open onOpenChange={() => undefined} prompts={[prompt]} />, 'visibility', '/app/p/p1/visibility', {
      'POST /api/v1/projects/p1/ai-visibility/observations/manual': { status: 201, body: { data: { id: 'ob1' } } },
    }); // prettier-ignore
    await userEvent.selectOptions(await screen.findByLabelText('Where you saw it'), 'GOOGLE_AI_OVERVIEW');
    await userEvent.type(
      screen.getByLabelText('The answer'),
      'Navkar Jewellers is often recommended for bridal sets.',
    );
    await userEvent.type(
      screen.getByLabelText(/Source links/),
      'https://navkar.example.in/bridal\nnot-a-link',
    );
    expect(screen.getByLabelText(/^City/)).toHaveValue('Surat');
    await userEvent.click(screen.getByRole('button', { name: 'Save observation' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST')!.init.body));
    expect(body).toMatchObject({ promptId: 'pr1', surface: 'GOOGLE_AI_OVERVIEW', citedUrls: ['https://navkar.example.in/bridal'], city: 'Surat' }); // prettier-ignore
    expect(new Date(body.observedAt).getTime()).toBeLessThanOrEqual(Date.now());
    await waitFor(() => expect(screen.getByTestId('current-location')).toHaveTextContent('/app/p/p1/visibility/observations/ob1')); // prettier-ignore
  });

  it('labels a manual observation and shows its limitations', async () => {
    inProject(<ObservationPage />, 'visibility/observations/:observationId', '/app/p/p1/visibility/observations/ob1', {
      'GET /api/v1/ai-visibility/observations/ob1': {
        body: {
          data: {
            id: 'ob1', provider: 'manual_google_ai_mode', model: null, country: 'IN', city: 'Surat', language: 'en', captureMethod: 'MANUAL',
            limitations: ['Entered by a person from Google AI Mode: one answer, seen once.'], note: 'Mobile, signed out',
            promptText: prompt.text, status: 'SUCCEEDED', isDemo: false, attempts: 1, errorCode: null, errorMessage: null, rawResponse: {},
            answerText: 'Navkar Jewellers is often recommended.', brandMentioned: true, brandCited: false, brandRank: 1, sentiment: null,
            sentimentSource: null, sentimentConfidence: null, latencyMs: null, observedAt: '2026-10-24T05:30:00Z', prompt: { id: 'pr1', text: prompt.text },
            mentions: [], citations: [],
          },
        },
      },
    }); // prettier-ignore
    expect(await screen.findByText('Manual observation · Google AI Mode')).toBeInTheDocument();
    expect(screen.getByText('Manual observation')).toBeInTheDocument();
    expect(screen.getByText(/Entered by a person from Google AI Mode/)).toBeInTheDocument();
    expect(screen.getByText('Note: Mobile, signed out')).toBeInTheDocument();
    expect(screen.getByText(/Surat, /)).toBeInTheDocument();
  });
});
