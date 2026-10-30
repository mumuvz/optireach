import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';

export function renderWithProviders(
  ui: ReactNode,
  { route = '/', path = '*' }: { route?: string; path?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <LocationProbe testId="current-location" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

/** Renders the current location so tests can assert navigation. */
export function LocationProbe({ testId = 'location' }: { testId?: string }) {
  const location = useLocation();
  return <output data-testid={testId}>{`${location.pathname}${location.search}${location.hash}`}</output>;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

/** Stubs fetch with a handler keyed by "METHOD /path" (query string ignored). Returns the call log. */
export function mockFetch(routes: Record<string, MockResponse | ((init: RequestInit) => MockResponse)>) {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, init });
    const entry = routes[`${method} ${url.pathname}`];
    const res = typeof entry === 'function' ? entry(init) : entry;
    if (!res)
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${method} ${url.pathname}` } }),
        { status: 404 },
      );
    const status = res.status ?? 200;
    return new Response(status === 204 || res.body === undefined ? null : JSON.stringify(res.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
