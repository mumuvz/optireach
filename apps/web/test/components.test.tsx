import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { FreeAuditForm } from '@/components/marketing/blocks';
import { PricingCards } from '@/components/marketing/pricing';
import { RequireAuth } from '@/lib/auth';
import { LoginPage } from '@/pages/auth/auth-pages';
import { mockFetch, renderWithProviders } from './utils';

describe('FreeAuditForm', () => {
  it('validates the URL locally before calling the API', async () => {
    const calls = mockFetch({});
    renderWithProviders(<FreeAuditForm />);
    await userEvent.type(screen.getByLabelText('Website address'), 'javascript:alert(1)');
    await userEvent.click(screen.getByRole('button', { name: /run a free audit/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('starts a real audit and keeps the access token out of the query string', async () => {
    document.cookie = 'sf_csrf=t';
    const calls = mockFetch({
      'POST /api/v1/public/audits': {
        status: 202,
        body: {
          data: {
            id: 'audit1',
            token: 'tok_abcdefghijklmnopqrstuvwx',
            status: 'QUEUED',
            url: 'https://example.com/',
            maxPages: 20,
          },
        },
      },
    });
    renderWithProviders(<FreeAuditForm />);
    await userEvent.type(screen.getByLabelText('Website address'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: /run a free audit/i }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent(
        '/free-audit#id=audit1&token=tok_abcdefghijklmnopqrstuvwx',
      ),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as { url: string };
    expect(body.url).toBe('https://example.com/');
  });
});

describe('PricingCards', () => {
  it('shows configured plans and switches to yearly prices', async () => {
    mockFetch({
      'GET /api/v1/billing/plans': {
        status: 503,
        body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } },
      },
    });
    renderWithProviders(<PricingCards />);
    // Falls back to the shared default plans when the API is unavailable.
    expect(screen.getByRole('heading', { name: 'Starter' })).toBeInTheDocument();
    expect(screen.getAllByText('Billed monthly').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('radio', { name: 'Yearly' }));
    expect(screen.getAllByText(/billed yearly/).length).toBeGreaterThan(0);
  });
});

describe('RequireAuth', () => {
  it('redirects signed-out visitors to login with a return path', async () => {
    mockFetch({
      'GET /api/v1/auth/me': {
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } },
      },
    });
    renderWithProviders(
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/app/p/:id" element={<p>secret dashboard</p>} />
        </Route>
      </Routes>,
      { route: '/app/p/123' },
    );
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fapp%2Fp%2F123'),
    );
    expect(screen.queryByText('secret dashboard')).not.toBeInTheDocument();
  });
});

describe('LoginPage', () => {
  it('shows the API error for disabled accounts', async () => {
    document.cookie = 'sf_csrf=t';
    mockFetch({
      'GET /api/v1/auth/me': {
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } },
      },
      'POST /api/v1/auth/login': {
        status: 403,
        body: { error: { code: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' } },
      },
    });
    renderWithProviders(<LoginPage />, { route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'some-password');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('This account has been disabled.')).toBeInTheDocument();
  });
});
