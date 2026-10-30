import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CODES,
  INDUSTRIES,
  INDUSTRY_KEYS,
  LANGUAGE_CODES,
  PRIORITY_COUNTRY_CODES,
  PRIORITY_LANGUAGE_CODES,
  canonicalLanguageCode,
  countryName,
  countryOptions,
  industryLabel,
  isCountryCode,
  isIndustryKey,
  isLanguageCode,
  languageOptions,
} from '../src/index';

describe('country constants', () => {
  it('contains all 249 ISO 3166-1 alpha-2 codes exactly once', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('keeps priority markets inside the full list', () => {
    for (const code of PRIORITY_COUNTRY_CODES) expect(isCountryCode(code)).toBe(true);
  });

  it('rejects unknown or lower-case codes', () => {
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('us')).toBe(false);
    expect(isCountryCode('USA')).toBe(false);
  });

  it('resolves display names and orders options with priority markets first', () => {
    expect(countryName('GB')).toBe('United Kingdom');
    const options = countryOptions();
    expect(options).toHaveLength(COUNTRY_CODES.length);
    expect(options.slice(0, PRIORITY_COUNTRY_CODES.length).map((o) => o.code)).toEqual([
      ...PRIORITY_COUNTRY_CODES,
    ]);
    const tail = options.slice(PRIORITY_COUNTRY_CODES.length).map((o) => o.name);
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
  });
});

describe('language constants', () => {
  it('has unique BCP 47 tags', () => {
    expect(new Set(LANGUAGE_CODES.map((c) => c.toLowerCase())).size).toBe(LANGUAGE_CODES.length);
    for (const code of LANGUAGE_CODES) expect(code).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
    for (const code of PRIORITY_LANGUAGE_CODES) expect(isLanguageCode(code)).toBe(true);
  });

  it('canonicalizes casing and rejects unsupported tags', () => {
    expect(canonicalLanguageCode('pt-br')).toBe('pt-BR');
    expect(canonicalLanguageCode(' EN ')).toBe('en');
    expect(canonicalLanguageCode('xx-YY')).toBeNull();
    expect(languageOptions()).toHaveLength(LANGUAGE_CODES.length);
  });
});

describe('industry constants', () => {
  it('has unique slug keys and labels', () => {
    expect(new Set(INDUSTRY_KEYS).size).toBe(INDUSTRIES.length);
    for (const industry of INDUSTRIES) {
      expect(industry.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(industry.label.length).toBeGreaterThan(2);
    }
    expect(INDUSTRY_KEYS).toContain('other');
  });

  it('looks up labels with a safe fallback', () => {
    expect(isIndustryKey('saas')).toBe(true);
    expect(isIndustryKey('not-real')).toBe(false);
    expect(industryLabel('saas')).toBe('Software & SaaS');
    expect(industryLabel(null)).toBe('Not specified');
    expect(industryLabel('custom')).toBe('custom');
  });
});
