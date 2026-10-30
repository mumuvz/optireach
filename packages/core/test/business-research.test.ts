// Business research on an observed ranking: positions, the computed comparison, Google's rules, and the action plan.
// Listings are SYNTHETIC (names and numbers shaped like a real Places page, not real data).
import { observedPositions, type LocalResult } from '@surfaced/shared';
import { describe, expect, it } from 'vitest';
import { DevLlmProvider, type LlmProvider } from '../src/ai/llm';
import { buildResearchEvidence, conflictsWithGoogleRules, nameExtras, researchBusiness } from '../src/local';

const row = (rank: number, title: string, o: Partial<LocalResult> = {}): LocalResult => ({
  rank,
  title,
  placeId: null,
  cid: null,
  domain: null,
  category: 'Jewelry store',
  rating: 4.8,
  reviewCount: 100,
  address: `${rank} Ring Rd`,
  latitude: null,
  longitude: null,
  isTarget: false,
  competitorId: null,
  entityId: `/g/${rank}`,
  phoneShown: true,
  hours: 'Open · Closes 8 pm',
  serviceOptions: ['In-store shopping', 'In-store pick-up', 'Delivery'],
  reviewSnippet: null,
  ...o,
});

const FIELD: LocalResult[] = [
  row(1, 'Sponsored Gems', { sponsored: true, reviewCount: 10 }),
  row(2, 'Alpha Jewellers', { reviewCount: 618, rating: 4.9 }),
  row(3, 'Beta Gold - Jewellery Shop Ring Road, Surat', { reviewCount: 1000 }),
  row(4, 'Gamma Jewels', { reviewCount: 245 }),
  row(5, 'Delta Diamonds', { reviewCount: 20 }),
  row(6, 'Zaver Test Jewellers', { reviewCount: 26, rating: 5, category: 'Costume jewelry shop', phoneShown: false, serviceOptions: ['Delivery'] }), // prettier-ignore
  row(7, 'Epsilon Ornaments', { reviewCount: 300 }),
];
const evidenceFor = (index: number, results = FIELD) =>
  buildResearchEvidence({ results, index, query: 'jewellery shop in surat', location: 'Surat', source: 'GOOGLE_CAPTURE', observationType: 'observed_search_position', capturedAt: new Date('2026-10-30T10:00:00Z') }); // prettier-ignore

describe('observed positions', () => {
  it('counts organic positions without ads, and keeps page-local positions on their own page', () => {
    expect(observedPositions(FIELD).map((p) => [p.position, p.organicPosition])).toEqual([[1, null], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6]]); // prettier-ignore
    const pages: LocalResult[] = [
      row(1, 'A', { batch: 1, sourcePosition: 1, cumulativePosition: 1 }),
      row(2, 'B', { batch: 1, sourcePosition: 2, cumulativePosition: 2 }),
      row(1, 'C', { batch: 2, sourcePosition: 1 }), // page 2 saved without its start= offset
    ];
    expect(observedPositions(pages)).toEqual([
      { position: 1, pageLocal: false, page: 1, organicPosition: 1 },
      { position: 2, pageLocal: false, page: 1, organicPosition: 2 },
      { position: 1, pageLocal: true, page: 2, organicPosition: null },
    ]);
  });
});

describe('research evidence (computed, no AI)', () => {
  it('compares the business with the listings above it and the top three, from what the results showed', () => {
    const e = evidenceFor(5); // Zaver Test Jewellers, #5 organic
    expect(e.target).toMatchObject({
      title: 'Zaver Test Jewellers',
      position: 6,
      organicPosition: 5,
      phoneShown: false,
    });
    expect(e.above.map((l) => l.title)).toEqual(['Delta Diamonds', 'Gamma Jewels', 'Beta Gold - Jewellery Shop Ring Road, Surat', 'Alpha Jewellers']); // prettier-ignore
    expect(e.leaders.map((l) => l.title)).toEqual(['Alpha Jewellers', 'Beta Gold - Jewellery Shop Ring Road, Surat', 'Gamma Jewels']); // prettier-ignore
    expect(e.field).toMatchObject({ listings: 7, organic: 6, sponsored: 1, leadersMedianReviews: 618, detailsCaptured: 6, withPhone: 5 }); // prettier-ignore
    const byTitle = Object.fromEntries(e.findings.map((f) => [f.title, f]));
    expect(byTitle['Ranks #5 of 6 organic listings collected']?.detail).toMatch(/1 ad appeared above it/);
    expect(byTitle['Fewer reviews than the top three']).toMatchObject({ tone: 'gap', detail: expect.stringMatching(/^26 reviews against a median of 618/) }); // prettier-ignore
    // Delta Diamonds ranks above with fewer reviews: reviews alone do not explain the order.
    expect(byTitle['Reviews alone do not explain the order']?.detail).toMatch(/1 of the 4 listings above have fewer reviews \(Delta Diamonds #4: 20 reviews\)/); // prettier-ignore
    expect(byTitle['No phone number on the listing']).toMatchObject({ tone: 'gap', detail: '5 of 6 listings show a phone number that customers can call straight from the results.' }); // prettier-ignore
    expect(byTitle['Different category from most listings']?.detail).toMatch(/Shows “Costume jewelry shop”; 5 of 6 listings \(3 of the top three\) show “Jewelry store”/); // prettier-ignore
    expect(byTitle['Service options the leaders show']?.detail).toMatch(/In-store shopping, In-store pick-up; this listing shows Delivery/); // prettier-ignore
    expect(byTitle['Some listings above may have keywords in their names']?.detail).toMatch(/^Beta Gold - Jewellery Shop Ring Road, Surat \(#2\)/); // prettier-ignore
    expect(byTitle['Distance is not shown on the page']).toBeDefined();
    expect(e.findings.map((f) => f.id)).toEqual(e.findings.map((_, i) => `F${i + 1}`));
  });

  it('does not judge details that were not captured for a listing', () => {
    const old = FIELD.map(({ phoneShown: _p, hours: _h, serviceOptions: _s, ...r }) => r);
    const e = evidenceFor(5, old);
    expect(e.target).toMatchObject({ phoneShown: null, serviceOptions: null, hours: null });
    expect(e.findings.map((f) => f.title)).not.toContain('No phone number on the listing');
    expect(e.findings.map((f) => f.title)).not.toContain('No opening hours shown');
    expect(e.limitations.join(' ')).toMatch(/were not captured for this listing/);
  });

  it('does not suggest a service option the listing says it does not offer', () => {
    const declined = FIELD.map((r, i) => (i === 5 ? { ...r, serviceOptions: ['Delivery', 'No in-store shopping'] } : r)); // prettier-ignore
    const detail = evidenceFor(5, declined).findings.find((f) => f.title === 'Service options the leaders show')?.detail; // prettier-ignore
    expect(detail).toMatch(/^The top three show In-store pick-up;/); // "In-store shopping" is declined, so not suggested
  });

  it('compares the website on the profile when the saved page’s data carried it', () => {
    const sites: [boolean, string | null][] = [[false, null], [true, 'https://alpha.example/'], [true, 'https://www.instagram.com/beta_gold'], [false, null], [true, 'https://delta.example/'], [false, null], [false, null]]; // prettier-ignore
    const withSites = FIELD.map((r, i) => ({ ...r, websiteListed: sites[i]![0], website: sites[i]![1] }));
    const none = evidenceFor(5, withSites);
    expect(none.target.websiteListed).toBe(false);
    expect(none.field).toMatchObject({ websiteKnown: 6, withWebsite: 3, withOwnSite: 2 });
    expect(none.findings.find((f) => f.title === 'No website on the profile')).toMatchObject({ tone: 'gap', area: 'website', detail: expect.stringMatching(/^3 of 6 listings list a website on their profile\./) }); // prettier-ignore
    expect(none.limitations.join(' ')).not.toMatch(/website was not captured/);

    const social = withSites.map((r, i) => (i === 5 ? { ...r, websiteListed: true, website: 'https://www.instagram.com/zaver_test?igsh=x' } : r)); // prettier-ignore
    const titles = evidenceFor(5, social).findings;
    expect(titles.find((f) => f.title === 'The profile’s website is a social media page')?.detail).toMatch(/^The profile links to instagram\.com, not a site of the business’s own; 2 of 6 listings link their own site\./); // prettier-ignore
    expect(titles.map((f) => f.title)).not.toContain('No website on the profile');
    // Older collections did not record it: no website finding, and the limitation says so.
    const old = evidenceFor(5);
    expect(old.findings.filter((f) => f.area === 'website')).toEqual([]);
    expect(old.limitations.join(' ')).toMatch(/Whether the profile lists a website was not captured/);
  });

  it('flags the signs of extra words in a business name, as a prompt to check', () => {
    expect(nameExtras('Nakrani Gold - Jewellery Shop Yogi chowk, Surat')).toBe(
      'Jewellery Shop Yogi chowk, Surat',
    );
    expect(nameExtras('USA Jewellers: Unique Hip Hop Jewellery for Every Style')).toBe('Unique Hip Hop Jewellery for Every Style'); // prettier-ignore
    expect(nameExtras('Sat Gold®')).toBe('®');
    expect(nameExtras('KASHYAP Gems & Jewellers')).toBeNull();
    expect(nameExtras('Shree Radhe Jewellers')).toBeNull();
  });
});

describe('Google’s rules', () => {
  it('catches prohibited tactics but not advice that warns against them', () => {
    for (const bad of [
      'Offer a 5% discount for every review.',
      'Ask only happy customers to leave reviews.',
      'Add keywords like jewellery shop to your business name.',
      'Have your staff write reviews for the store.',
      'Buy a package of Google reviews.',
    ])
      expect(conflictsWithGoogleRules(bad), bad).toBe(true);
    for (const fine of [
      'Never offer discounts or gifts for reviews.',
      'Ask every customer for a genuine review after the purchase.',
      'Do not add keywords to the business name.',
      'Reply to every review within two days.',
      'Include the area name in the website page title.',
    ])
      expect(conflictsWithGoogleRules(fine), fine).toBe(false);
  });
});

describe('action plan', () => {
  const model = (actions: unknown[]): LlmProvider => ({
    key: 'openai',
    label: 'Test model',
    isDevAdapter: false,
    generateJson: async (req) => ({
      data: req.schema.parse({ summary: 'Fewer reviews than the leaders.', strengths: ['Top rating'], actions, verify: ['Photos'] }), // prettier-ignore
      provider: 'openai',
      model: 'test-model',
      isDevAdapter: false,
      usage: null,
    }),
  });

  it('keeps only real finding IDs, orders by priority, and drops suggestions that break Google’s rules', async () => {
    const e = evidenceFor(5);
    const r = await researchBusiness(
      model([
        { title: 'Add photos', area: 'photos', priority: 'low', effort: 'low', why: 'Show the store.', steps: ['Add storefront photos.'], evidence: [] }, // prettier-ignore
        { title: 'Grow reviews', area: 'reviews', priority: 'high', effort: 'medium', why: 'Fewer reviews.', steps: ['Ask every customer for a review.', 'Offer a 10% discount for each review.'], evidence: ['F2', 'f3', 'F99'] }, // prettier-ignore
        { title: 'Put keywords in the name', area: 'policy', priority: 'high', effort: 'low', why: 'Add keywords like jewellery shop to your business name.', steps: ['Rename it.'], evidence: [] }, // prettier-ignore
      ]),
      e,
    );
    expect(r.report.actions.map((a) => [a.title, a.priority, a.evidence, a.steps])).toEqual([
      ['Grow reviews', 'high', ['F2', 'F3'], ['Ask every customer for a review.']],
      ['Add photos', 'low', [], ['Add storefront photos.']],
    ]);
    expect(r.report.removedForPolicy).toBe(2); // one step, one whole action
    expect(r).toMatchObject({ provider: 'openai', model: 'test-model', isDevAdapter: false });
  });

  it('fails instead of returning an empty plan', async () => {
    await expect(researchBusiness(model([]), evidenceFor(5))).rejects.toThrow(/no usable actions/);
  });

  it('builds a labelled template plan from the findings with the dev adapter', async () => {
    const e = evidenceFor(
      5,
      FIELD.map((r) => ({ ...r, websiteListed: r.title !== 'Zaver Test Jewellers' })),
    );
    const r = await researchBusiness(new DevLlmProvider(), e);
    expect(r.isDevAdapter).toBe(true);
    expect(r.report.summary).toMatch(/^Zaver Test Jewellers is #5 of 6 organic listings for “jewellery shop in surat”\. .*Template plan/); // prettier-ignore
    const titles = r.report.actions.map((a) => a.title);
    expect(titles).toEqual(expect.arrayContaining(['Ask every customer for a genuine review', 'Add the business phone number', 'Check the primary category', 'Add a website to the profile'])); // prettier-ignore
    const ids = new Set(e.findings.map((f) => f.id));
    expect(r.report.actions.every((a) => a.evidence.every((id) => ids.has(id)))).toBe(true);
    expect(r.report.actions.flatMap((a) => a.steps).some(conflictsWithGoogleRules)).toBe(false);
  });
});
