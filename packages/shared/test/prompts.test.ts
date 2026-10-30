import { describe, expect, it } from 'vitest';
import {
  KEYWORD_QUESTION_TEMPLATES,
  agencyLinkRequestSchema,
  PROMPT_BULK_MAX,
  expandKeywords,
  normalizePromptText,
  promptBulkInputSchema,
} from '../src';

describe('bulk prompts', () => {
  it('turns keywords into questions without duplicates', () => {
    const templates = KEYWORD_QUESTION_TEMPLATES.filter((t) => t.key === 'best' || t.key === 'best-in').map(
      (t) => t.template,
    );
    expect(
      expandKeywords(
        ['wedding invitation maker', '  Wedding   invitation maker ', '', 'haldi card'],
        templates,
        {
          country: 'India',
        },
      ),
    ).toEqual([
      'What is the best wedding invitation maker?',
      'Best wedding invitation maker in India',
      'What is the best haldi card?',
      'Best haldi card in India',
    ]);
  });

  it('compares prompts ignoring case, spacing and trailing punctuation', () => {
    expect(normalizePromptText('  Best  CRM for startups?! ')).toBe('best crm for startups');
  });

  it('limits a bulk request to the maximum size', () => {
    const base = { country: 'IN', language: 'en', providers: ['mock_demo'] };
    expect(
      promptBulkInputSchema.safeParse({ ...base, texts: ['What is the best invitation app?'] }).success,
    ).toBe(true);
    expect(
      promptBulkInputSchema.safeParse({
        ...base,
        texts: Array.from({ length: PROMPT_BULK_MAX + 1 }, (_, i) => `Question number ${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('agency codes', () => {
  it('accepts workspace slugs whose random part contains an underscore', () => {
    expect(agencyLinkRequestSchema.safeParse({ agencyCode: 'acme-agency-a_b9' }).success).toBe(true);
    expect(agencyLinkRequestSchema.safeParse({ agencyCode: 'acme agency' }).success).toBe(false);
  });
});
