import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildUrl, setUnauthenticatedHandler } from '@/lib/api';
import { safeNextPath } from '@/lib/auth';
import { formatDuration, formatNumber, formatPercent, shortUrl, urlPath } from '@/lib/format';
import { fullTitle, jsonLdText, renderHeadTags } from '@/lib/seo';
import { mockFetch } from './utils';

describe('API client', () => {
  it('builds query strings without empty values and repeats array params', () => {
    expect(
      buildUrl('/projects', { workspaceId: 'w1', q: '', page: 2, tags: ['a', 'b'], skip: undefined }),
    ).toBe('/api/v1/projects?workspaceId=w1&page=2&tags=a&tags=b');
  });

  it('sends the CSRF cookie value and retries once with a fresh token after CSRF_INVALID', async () => {
    document.cookie = 'sf_csrf=stale-token';
    let attempts = 0;
    const calls = mockFetch({
      'POST /api/v1/things': (init) => {
        attempts += 1;
        const header = (init.headers as Record<string, string>)['X-CSRF-Token'];
        if (attempts === 1) {
          expect(header).toBe('stale-token');
          document.cookie = 'sf_csrf=fresh-token';
          return { status: 403, body: { error: { code: 'CSRF_INVALID', message: 'Expired' } } };
        }
        return { status: 201, body: { data: { ok: header } } };
      },
      'GET /api/v1/auth/csrf': { body: { data: { csrfToken: 'fresh-token' } } },
    });
    await expect(api.post<{ ok: string }>('/things', { a: 1 })).resolves.toEqual({ ok: 'fresh-token' });
    expect(calls.filter((c) => c.path === '/api/v1/things')).toHaveLength(2);
    expect(calls.every((c) => c.init.credentials === 'include')).toBe(true);
  });

  it('maps validation errors to fields and calls the 401 handler', async () => {
    document.cookie = 'sf_csrf=t';
    mockFetch({
      'POST /api/v1/projects': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Some fields are invalid.',
            details: [{ path: 'body.websiteUrl', message: 'Invalid website address' }],
          },
        },
      },
      'GET /api/v1/projects': {
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } },
      },
    });
    const error = await api.post('/projects', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).fieldErrors).toEqual({ websiteUrl: 'Invalid website address' });

    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    setUnauthenticatedHandler(null);
  });

  it('reports network failures as a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(api.get('/health')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});

describe('safe redirects', () => {
  it('only accepts same-site paths', () => {
    expect(safeNextPath('/app/p/1')).toBe('/app/p/1');
    expect(safeNextPath('//evil.example/x')).toBe('/app');
    expect(safeNextPath('/\\evil.example')).toBe('/app');
    expect(safeNextPath('https://evil.example')).toBe('/app');
    expect(safeNextPath(null)).toBe('/app');
  });
});

describe('SEO head tags', () => {
  it('renders title, canonical, Open Graph and escaped JSON-LD', () => {
    const head = renderHeadTags({
      title: 'Pricing',
      description: 'Plans "for" <everyone>',
      path: '/pricing',
      jsonLd: { '@type': 'Thing', name: '</script><script>alert(1)</script>' },
    });
    expect(head).toContain('<title>Pricing | Surfaced</title>');
    expect(head).toContain('content="Plans &quot;for&quot; &lt;everyone&gt;"');
    expect(head).toMatch(/<link rel="canonical" href="[^"]+\/pricing" data-seo>/);
    expect(head).toContain('property="og:image"');
    expect(head).not.toContain('</script><script>');
    expect(jsonLdText({ a: '<b>' })).toBe('{"a":"' + String.fromCharCode(92) + 'u003cb>"}');
  });

  it('marks noindex pages and keeps the brand out of duplicated titles', () => {
    expect(renderHeadTags({ title: 'Log in', description: 'x', path: '/login', noindex: true })).toContain(
      '<meta name="robots" content="noindex, nofollow" data-seo>',
    );
    expect(fullTitle('Surfaced — SEO platform')).toBe('Surfaced — SEO platform');
  });
});

describe('formatting', () => {
  it('never shows missing values as zero', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.3456, 1)).toBe('34.6%');
    expect(formatDuration(2600)).toBe('2.6 s');
  });

  it('shortens URLs for tables', () => {
    expect(shortUrl('https://www.example.com/a/b?x=1')).toBe('example.com/a/b?x=1');
    expect(urlPath('https://example.com/')).toBe('/');
  });
});
