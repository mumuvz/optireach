import { describe, expect, it } from 'vitest';
import {
  contentGenerateSchema,
  csvListSchema,
  domainOf,
  isSameOrSubdomain,
  issueListQuerySchema,
  normalizeDomain,
  normalizeWebsiteUrl,
  passwordSchema,
  projectCreateSchema,
  registerSchema,
  reportCreateSchema,
  safeNormalizeWebsiteUrl,
  visibilityFilterSchema,
} from '../src/index';
import { z } from 'zod';

describe('normalizeWebsiteUrl', () => {
  it('adds https, lower-cases the host and strips query and fragment', () => {
    const result = normalizeWebsiteUrl('  WWW.Example.COM/Pricing?utm=1#top ');
    expect(result).toEqual({
      url: 'https://www.example.com/Pricing',
      origin: 'https://www.example.com',
      protocol: 'https:',
      hostname: 'www.example.com',
      domain: 'example.com',
      port: '',
    });
  });

  it('keeps explicit ports and http', () => {
    expect(normalizeWebsiteUrl('http://example.org:8080').url).toBe('http://example.org:8080/');
  });

  it('converts internationalized domains to punycode', () => {
    expect(normalizeWebsiteUrl('bücher.de').hostname).toBe('xn--bcher-kva.de');
  });

  it.each([
    ['', 'EMPTY'],
    ['ftp://example.com', 'UNSUPPORTED_PROTOCOL'],
    ['javascript:alert(1)', 'INVALID_URL'], // becomes https://javascript:alert(1) → invalid port
    ['javascript://evil.example/%0aalert(1)', 'UNSUPPORTED_PROTOCOL'],
    ['https://user:pass@example.com', 'CREDENTIALS_NOT_ALLOWED'],
    ['https://intranet', 'INVALID_HOSTNAME'],
    ['https://exa mple.com', 'INVALID_URL'],
  ])('rejects %j', (input, code) => {
    const result = safeNormalizeWebsiteUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('normalizes competitor domains and compares subdomains', () => {
    expect(normalizeDomain('https://www.Rival.io/blog')).toBe('rival.io');
    expect(domainOf('https://docs.rival.io/x')).toBe('docs.rival.io');
    expect(domainOf('mailto:a@b.c')).toBeNull();
    expect(isSameOrSubdomain('docs.rival.io', 'rival.io')).toBe(true);
    expect(isSameOrSubdomain('notrival.io', 'rival.io')).toBe(false);
  });
});

describe('request schemas', () => {
  it('normalizes registration input', () => {
    const parsed = registerSchema.parse({
      name: ' Ada Lovelace ',
      email: ' Ada@Example.COM ',
      password: 'correct horse battery',
      acceptTerms: true,
    });
    expect(parsed.email).toBe('ada@example.com');
    expect(parsed.name).toBe('Ada Lovelace');
    expect(registerSchema.safeParse({ ...parsed, acceptTerms: false }).success).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('aaaaaaaaaaaa').success).toBe(false);
    expect(passwordSchema.safeParse('a-much-better-passphrase').success).toBe(true);
  });

  it('normalizes a project payload', () => {
    const parsed = projectCreateSchema.parse({
      name: 'Acme Outdoor',
      websiteUrl: 'acme-outdoor.com',
      targetCountries: ['us', 'gb'],
      targetLanguages: ['EN', 'pt-br'],
      competitors: [{ name: 'Rival', domain: 'https://www.rival.com/' }],
    });
    expect(parsed.websiteUrl).toBe('https://acme-outdoor.com/');
    expect(parsed.targetCountries).toEqual(['US', 'GB']);
    expect(parsed.targetLanguages).toEqual(['en', 'pt-BR']);
    expect(parsed.competitors?.[0]?.domain).toBe('rival.com');
    expect(projectCreateSchema.safeParse({ ...parsed, targetCountries: ['ZZ'] }).success).toBe(false);
  });

  it('parses comma-separated query filters', () => {
    const schema = z.object({ severity: csvListSchema(z.enum(['HIGH', 'LOW'])) });
    expect(schema.parse({ severity: 'HIGH, LOW' }).severity).toEqual(['HIGH', 'LOW']);
    expect(schema.parse({ severity: ['LOW'] }).severity).toEqual(['LOW']);
    expect(schema.parse({}).severity).toBeUndefined();
    expect(schema.safeParse({ severity: 'HIGH,BOGUS' }).success).toBe(false);

    const query = issueListQuerySchema.parse({ severity: 'CRITICAL,HIGH', page: '2' });
    expect(query).toMatchObject({
      severity: ['CRITICAL', 'HIGH'],
      page: 2,
      pageSize: 25,
      sort: 'severity',
      order: 'desc',
    });
  });

  it('requires a heading for section regeneration', () => {
    expect(contentGenerateSchema.safeParse({ mode: 'section' }).success).toBe(false);
    expect(contentGenerateSchema.safeParse({ mode: 'section', sectionHeading: 'Pricing' }).success).toBe(
      true,
    );
    expect(contentGenerateSchema.safeParse({ mode: 'article' }).success).toBe(true);
  });

  it('validates report date ranges', () => {
    const ok = reportCreateSchema.safeParse({
      title: 'October report',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      sections: ['audit_summary'],
    });
    expect(ok.success).toBe(true);
    const reversed = reportCreateSchema.safeParse({
      title: 'Bad',
      dateFrom: '2026-10-31',
      dateTo: '2026-10-01',
      sections: ['audit_summary'],
    });
    expect(reversed.success).toBe(false);
  });

  it('defaults visibility filters to all providers', () => {
    expect(visibilityFilterSchema.parse({}).provider).toBe('all');
    expect(visibilityFilterSchema.safeParse({ provider: 'gemini' }).success).toBe(false);
  });
});
