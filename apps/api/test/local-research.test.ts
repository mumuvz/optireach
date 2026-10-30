// Business research on collected rankings, end to end. The pages are SYNTHETIC test markup in the layout of a real
// saved Places page (udm=local): entity-ID cards with a heading, rating · category line, address · phone line, hours
// and service options. The AI model is the dev adapter or a test double — no real model is called.
import { setLlmProviderOverride, type LlmProvider } from '@surfaced/core/ai';
import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, prisma } = createTestApp();
afterAll(async () => {
  await disconnectPrisma();
});
afterEach(() => setLlmProviderOverride(undefined));

const Q1 = 'best jewellery shop in nana varachha surat';
const Q2 = 'jewellery shop in surat';
const urlOf = (q: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}&udm=local`;

interface Card { id: string; name: string; reviews: number; rating?: number; category?: string; phone?: boolean; services?: string; sponsored?: boolean } // prettier-ignore
function card(c: Card) {
  return (
    `<div><div id="pv-/g/${c.id}" role="button"><div><div aria-level="3" role="heading"><span>${c.name}</span></div>` +
    (c.sponsored ? '<div><span>Sponsored</span></div>' : '') +
    `<div><span aria-label="Rated ${(c.rating ?? 4.8).toFixed(1)} out of 5, ${c.reviews} user reviews">${(c.rating ?? 4.8).toFixed(1)}(${c.reviews})</span> · ${c.category ?? 'Jewelry store'}</div>` + // prettier-ignore
    `<div>${c.name} Road${c.phone === false ? '' : ' · 098765 43210'}</div><div>Open · Closes 8 pm</div>` +
    `<div>${c.services ?? 'In-store shopping·In-store pick-up·Delivery'}</div></div></div></div>`
  );
}
function page(q: string, cards: Card[]) {
  const url = urlOf(q);
  return `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><title>${q} - Google Search</title></head><body><div>${cards.map(card).join('')}</div></body></html>`; // prettier-ignore
}

const AD: Card = { id: 'ad01', name: 'Sponsored Gems', reviews: 12, sponsored: true };
const ALPHA: Card = { id: 'al01', name: 'Alpha Jewellers', reviews: 618, rating: 4.9 };
const BETA: Card = { id: 'be01', name: 'Beta Gold - Jewellery Shop Yogi chowk, Surat', reviews: 1000 };
const GAMMA: Card = { id: 'ga01', name: 'Gamma Jewels', reviews: 245 };
const ZAVER: Card = { id: 'za01', name: 'Zaver Jewellers', reviews: 26, rating: 5, category: 'Costume jewelry shop', phone: false, services: 'Delivery·No in-store shopping' }; // prettier-ignore
const ONLY_AD: Card = { id: 'oa01', name: 'Ad Only Ornaments', reviews: 3, sponsored: true };

async function setup() {
  const { client, workspaceId } = await registerClient(app);
  const project = (await client.post('/projects', { workspaceId, name: 'Research Co', targetCountries: ['IN'], targetLanguages: ['en'], locations: [{ name: 'Research Co', kind: 'STOREFRONT', addressLine1: 'Ring Rd', city: 'Surat', country: 'IN', latitude: 21.17, longitude: 72.83 }] })).body.data; // prettier-ignore
  const location = (await client.get(`/projects/${project.id}/locations`)).body.data[0];
  const collect = async (q: string, cards: Card[]) => {
    const query = (await client.post(`/projects/${project.id}/local/queries`, { query: q, locationId: location.id, gridSize: 1 })).body.data; // prettier-ignore
    const r = await client.post(`/projects/${project.id}/local/queries/${query.id}/google-capture`, { pages: [{ html: page(q, cards) }] }); // prettier-ignore
    expect(r.status).toBe(200);
    return r.body.data.scanId as string;
  };
  const p = `/projects/${project.id}/local`;
  return { client, projectId: project.id as string, collect, p };
}

describe('business research on collected rankings', () => {
  it('finds a business by name across collected searches, then researches it against the listings above it', async () => {
    const { client, collect, p } = await setup();
    const scan1 = await collect(Q1, [AD, ALPHA, BETA, GAMMA, ZAVER, ONLY_AD]);
    await collect(Q2, [ZAVER, ALPHA, GAMMA]);

    // Find by name: one match per search, with its organic position there.
    const found = await client.get(`${p}/listings?q=zaver`);
    expect(found.status).toBe(200);
    expect(found.body.data.map((m: { query: string; position: number; resultIndex: number }) => [m.query, m.position])).toEqual(expect.arrayContaining([[Q1, 4], [Q2, 1]])); // prettier-ignore
    const match = found.body.data.find((m: { query: string }) => m.query === Q1);
    expect(match).toMatchObject({ title: 'Zaver Jewellers', scanId: scan1, sponsored: false, reviewCount: 26, observationType: 'observed_search_position' }); // prettier-ignore

    // Research it (dev adapter: a labelled template plan from the computed findings).
    const run = await client.post(`${p}/scans/${scan1}/research`, { resultIndex: match.resultIndex });
    expect(run.status).toBe(200);
    const r = run.body.data;
    expect(r).toMatchObject({ businessName: 'Zaver Jewellers', position: 4, pageLocal: false, query: Q1, provider: 'dev', isDevAdapter: true }); // prettier-ignore
    expect(r.evidence.target).toMatchObject({ phoneShown: false, serviceOptions: ['Delivery', 'No in-store shopping'], category: 'Costume jewelry shop' }); // prettier-ignore
    expect(r.evidence.above.map((l: { title: string }) => l.title)).toEqual(['Gamma Jewels', 'Beta Gold - Jewellery Shop Yogi chowk, Surat', 'Alpha Jewellers']); // prettier-ignore
    expect(r.evidence.otherSearches).toEqual([
      expect.objectContaining({ query: Q2, position: 1, listings: 3 }),
    ]);
    const titles = r.evidence.findings.map((f: { title: string }) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['Ranks #4 of 4 organic listings collected', 'Fewer reviews than the top three', 'No phone number on the listing', 'Some listings above may have keywords in their names', 'Also listed in 1 other collected search'])); // prettier-ignore
    const ids = new Set(r.evidence.findings.map((f: { id: string }) => f.id));
    expect(r.report.actions.length).toBeGreaterThan(2);
    expect(r.report.actions.every((a: { evidence: string[] }) => a.evidence.every((id) => ids.has(id)))).toBe(
      true,
    );

    // Listed and fetched again.
    const list = await client.get(`${p}/scans/${scan1}/research`);
    expect(list.body.data).toEqual([expect.objectContaining({ id: r.id, resultIndex: match.resultIndex, businessName: 'Zaver Jewellers' })]); // prettier-ignore
    expect((await client.get(`${p}/research/${r.id}`)).body.data).toMatchObject({ id: r.id, createdBy: expect.any(String), report: { summary: expect.stringContaining('Zaver Jewellers is #4') } }); // prettier-ignore
  });

  it('researches the organic listing for an ad, and refuses a business that appears only as an ad', async () => {
    const { client, collect, p } = await setup();
    const adTwin: Card = { ...GAMMA, sponsored: true };
    const scan = await collect(Q1, [adTwin, ALPHA, GAMMA, ONLY_AD]);
    const rows = (await client.get(`${p}/scans/${scan}`)).body.data.points[0].results as { title: string; sponsored?: boolean }[]; // prettier-ignore
    const adIndex = rows.findIndex((x) => x.title === 'Gamma Jewels' && x.sponsored);
    const organicIndex = rows.findIndex((x) => x.title === 'Gamma Jewels' && !x.sponsored);
    const twin = await client.post(`${p}/scans/${scan}/research`, { resultIndex: adIndex });
    expect(twin.status).toBe(200);
    expect(twin.body.data).toMatchObject({ resultIndex: organicIndex, position: 2 });
    const onlyAd = await client.post(`${p}/scans/${scan}/research`, { resultIndex: rows.findIndex((x) => x.title === 'Ad Only Ornaments') }); // prettier-ignore
    expect(onlyAd.status).toBe(400);
    expect(onlyAd.body.error.message).toMatch(/only as an ad/);
  });

  it('removes model suggestions that break Google’s rules and citations to findings that do not exist', async () => {
    const { client, collect, p } = await setup();
    const scan = await collect(Q1, [ALPHA, BETA, ZAVER]);
    const fake: LlmProvider = {
      key: 'openai',
      label: 'Test model',
      isDevAdapter: false,
      generateJson: async (req) => ({
        data: req.schema.parse({
          summary: 'Fewer reviews than the two listings above.',
          strengths: ['A 5.0 rating'],
          actions: [
            { title: 'Grow genuine reviews', area: 'reviews', priority: 'high', effort: 'medium', why: 'Fewer reviews than the leaders.', steps: ['Ask every customer for a review at billing.', 'Give a free gift for every 5-star review.'], evidence: ['F2', 'F42'] }, // prettier-ignore
            { title: 'Rename the shop', area: 'policy', priority: 'high', effort: 'low', why: 'Add keywords like jewellery shop to your business name.', steps: ['Edit the name.'], evidence: [] }, // prettier-ignore
          ],
          verify: ['Photos on the profile'],
        }),
        provider: 'openai',
        model: 'test-model',
        isDevAdapter: false,
        usage: null,
      }),
    };
    setLlmProviderOverride(fake);
    const r = await client.post(`${p}/scans/${scan}/research`, { resultIndex: 2 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ provider: 'openai', model: 'test-model', isDevAdapter: false });
    expect(r.body.data.report).toMatchObject({
      removedForPolicy: 2,
      actions: [{ title: 'Grow genuine reviews', evidence: ['F2'], steps: ['Ask every customer for a review at billing.'] }], // prettier-ignore
    });
  });

  it('needs an observed ranking, a real listing, and project access', async () => {
    const { client, projectId, collect, p } = await setup();
    const scan = await collect(Q1, [ALPHA, ZAVER]);
    expect((await client.post(`${p}/scans/${scan}/research`, { resultIndex: 9 })).status).toBe(400);
    expect((await client.get(`${p}/listings?q=a`)).status).toBe(400); // too short to search
    await prisma.localRankScan.update({ where: { id: scan }, data: { observationType: 'discovery_order' } });
    const discovery = await client.post(`${p}/scans/${scan}/research`, { resultIndex: 0 });
    expect(discovery.status).toBe(400);
    expect(discovery.body.error.message).toMatch(/not a search ranking/);
    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/local/listings?q=zaver`)).status).toBe(404);
    expect((await outsider.client.get(`/projects/${projectId}/local/scans/${scan}/research`)).status).toBe(
      404,
    );
    expect((await outsider.client.post(`/projects/${projectId}/local/scans/${scan}/research`, { resultIndex: 0 })).status).toBe(404); // prettier-ignore
  });
});
