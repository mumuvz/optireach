// Multi-page Google page collections (resumable). The pages are SYNTHETIC test markup that follows the structure of
// a real saved Places page (udm=local): cards carrying a Knowledge Graph entity ID (id="pv-/g/…"), a heading, a rating
// line and an address line, and Google's next-page link (a#pnnext) with its start= offset. The one exception is the
// Google Maps list test, which uses the core package's sanitised extract of a real saved Maps page.
import { readFileSync } from 'node:fs';
import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, prisma } = createTestApp();
afterAll(async () => {
  await disconnectPrisma();
});

const Q = 'best jewellery shop in surat';
const BASE = 'https://www.google.com/search?q=best+jewellery+shop+in+surat&udm=local';
const at = (start?: number) => (start === undefined ? BASE : `${BASE}&start=${start}`);

/** One card in the real Places layout. Each business has its own entity ID and address. */
function card(id: string, name: string, sponsored = false) {
  return (
    `<div><div id="pv-/g/${id}" role="button"><div><div aria-level="3" role="heading"><span>${name}</span></div>` +
    (sponsored ? '<div><span>Sponsored</span></div>' : '') +
    `<div><span aria-label="Rated 4.5 out of 5, 10 user reviews">4.5 (10)</span> · Jewelry store</div>` +
    `<div>${name} Road · 00000 00000</div><div>Open · Closes 8 pm</div></div></div></div>`
  );
}
/** A saved Places page: the browser-recorded address (optional), the cards, and Google's next link (optional). */
function page(opts: { start?: number; cards: string[]; next?: number; recorded?: boolean }) {
  const url = at(opts.start);
  const saved = opts.recorded === false ? '' : `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n`; // prettier-ignore
  const next = opts.next === undefined ? '' : `<a id="pnnext" href="${at(opts.next).replace(/&/g, '&amp;')}"><span>Next</span></a>`; // prettier-ignore
  return `${saved}<html><head><title>${Q} - Google Search</title></head><body><div>${opts.cards.join('')}</div>${next}</body></html>`; // prettier-ignore
}
const CONSENT = '<html><title>Before you continue to Google</title><form action="https://consent.google.com/save"></form></html>'; // prettier-ignore
const A = card('a1', 'Alpha Jewels');
const B = card('b2', 'Beta Gold');
const C = card('c3', 'Gamma Gems');
const D = card('d4', 'Delta Diamonds');
const E = card('e5', 'Epsilon Ornaments');
const F = card('f6', 'Zeta Silver');

async function setup() {
  const { client, workspaceId } = await registerClient(app);
  const project = (await client.post('/projects', { workspaceId, name: 'Collector Co', targetCountries: ['IN'], targetLanguages: ['en'], locations: [{ name: 'Collector Co', kind: 'STOREFRONT', addressLine1: 'Ring Rd', city: 'Surat', country: 'IN', latitude: 21.17, longitude: 72.83 }] })).body.data; // prettier-ignore
  const location = (await client.get(`/projects/${project.id}/locations`)).body.data[0];
  const query = (await client.post(`/projects/${project.id}/local/queries`, { query: Q, locationId: location.id, gridSize: 1 })).body.data; // prettier-ignore
  const start = (pages: { url?: string; html: string }[], target?: number) =>
    client.post(`/projects/${project.id}/local/queries/${query.id}/google-capture`, { pages, ...(target ? { target } : {}) }); // prettier-ignore
  const add = (scanId: string, pages: { url?: string; html: string }[]) =>
    client.post(`/projects/${project.id}/local/scans/${scanId}/google-capture/pages`, { pages });
  const scan = async (scanId: string) => (await client.get(`/projects/${project.id}/local/scans/${scanId}`)).body.data; // prettier-ignore
  return { client, projectId: project.id as string, queryId: query.id as string, start, add, scan };
}

type Row = { title: string; rank: number; batch: number; sourcePosition: number; cumulativePosition: number | null; alsoSeen?: { batch: number; sourcePosition: number; cumulativePosition: number | null }[] }; // prettier-ignore

describe('multi-page Google page collection', () => {
  it('collects pages of different sizes, continues from each page’s own offset, and stops when Google has no next page', async () => {
    const { start, add, scan } = await setup();
    const first = await start([{ html: page({ cards: [A, B, C], next: 3 }) }]);
    expect(first.status).toBe(200);
    const id = first.body.data.scanId as string;
    // The default target is 1000; 3 listings is a first batch, not the end.
    expect(first.body.data.progress).toMatchObject({ state: 'IN_PROGRESS', target: 1000, uniqueBusinesses: 3, pagesProcessed: 1, nextUrl: expect.stringContaining('start=3') }); // prettier-ignore

    // Page 2 starts at offset 3 (not 20) and repeats Beta Gold: kept once, its first position preserved.
    const second = await add(id, [{ html: page({ start: 3, cards: [D, B, E], next: 6 }) }]);
    expect(second.body.data.batches[0]).toMatchObject({ batch: 2, start: 3, offsetKnown: true, listings: 3, newListings: 2, duplicates: 1 }); // prettier-ignore
    expect(second.body.data.progress).toMatchObject({ state: 'IN_PROGRESS', uniqueBusinesses: 5, duplicatesSkipped: 1, nextUrl: expect.stringContaining('start=6') }); // prettier-ignore

    // Page 3 has one listing and no next link: the source is exhausted, below the target.
    const third = await add(id, [{ html: page({ start: 6, cards: [F] }) }]);
    expect(third.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', uniqueBusinesses: 6, listingsExtracted: 7, pagesProcessed: 3, nextUrl: null, reason: expect.stringMatching(/Page 3 .* no next-page link.* 6 unique/) }); // prettier-ignore
    const done = await scan(id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', collectionStatus: 'successful', captureProgress: { state: 'SOURCE_EXHAUSTED' } }); // prettier-ignore
    const rows = done.points[0].results as Row[];
    // Observed order and Google's global positions; #5 was Beta Gold again, so there is no new row for it.
    expect(rows.map((r) => [r.title, r.rank, r.batch, r.sourcePosition])).toEqual([
      ['Alpha Jewels', 1, 1, 1],
      ['Beta Gold', 2, 1, 2],
      ['Gamma Gems', 3, 1, 3],
      ['Delta Diamonds', 4, 2, 1],
      ['Epsilon Ornaments', 6, 2, 3],
      ['Zeta Silver', 7, 3, 1],
    ]);
    expect(rows[1]!.alsoSeen).toEqual([{ batch: 2, sourcePosition: 2, cumulativePosition: 5 }]);
    // An ended collection takes no more pages.
    expect((await add(id, [{ html: page({ start: 9, cards: [card('g7', 'Eta Jewels')] }) }])).status).toBe(
      409,
    );
  });

  it('keeps page-local positions when an offset is unknown, and stops on repeated pages and backward links', async () => {
    const { start, add, scan } = await setup();
    const id = (await start([{ html: page({ cards: [A, B], next: 2 }) }])).body.data.scanId as string;
    // No address entered and none recorded in the file: its place in the order is unknown.
    const local = await add(id, [{ html: page({ cards: [C], next: 4, recorded: false }) }]);
    expect(local.body.data.batches[0]).toMatchObject({ offsetKnown: false, newListings: 1 });
    const rows = (await scan(id)).points[0].results as Row[];
    const local1 = rows.find((r) => r.title === 'Gamma Gems')!;
    expect(local1).toMatchObject({ rank: 1, sourcePosition: 1, batch: 2 });
    expect(local1.cumulativePosition ?? null).toBeNull(); // no global position: page-local only
    expect((await scan(id)).captureProgress.notes.join(' ')).toMatch(/Page 2 had no start=.*page-local/);
    // The first page again (same address): repeated, nothing added; twice in a row means the results are repeating.
    const again = await add(id, [{ html: page({ cards: [A, B], next: 2 }) }]);
    expect(again.body.data.batches[0]).toMatchObject({ status: 'repeated', newListings: 0, duplicates: 2 });
    expect(again.body.data.progress.state).toBe('IN_PROGRESS');
    const twice = await add(id, [{ html: page({ cards: [A, B], next: 2 }) }]);
    expect(twice.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', reason: expect.stringMatching(/last 2 pages added no new businesses/) }); // prettier-ignore

    // A next link that points back to an earlier offset is a pagination loop.
    const loop = await setup();
    const loopId = (await loop.start([{ html: page({ cards: [A], next: 1 }) }])).body.data.scanId as string;
    const back = await loop.add(loopId, [{ html: page({ start: 1, cards: [B], next: 0 }) }]);
    expect(back.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', reason: expect.stringMatching(/next link leads back/) }); // prettier-ignore
  });

  it('keeps every earlier batch when a later page fails, and resumes from where it stopped', async () => {
    const { start, add, scan } = await setup();
    const id = (await start([{ html: page({ cards: [A, B], next: 2 }) }])).body.data.scanId as string;
    await add(id, [{ html: page({ start: 2, cards: [C], next: 3 }) }]);
    const failed = await add(id, [{ html: CONSENT }]);
    expect(failed.body.data).toMatchObject({
      collectionStatus: 'failed',
      batches: [{ batch: 3, status: 'failed' }],
    });
    expect(failed.body.data.progress).toMatchObject({ state: 'IN_PROGRESS', uniqueBusinesses: 3, pagesFailed: 1, nextUrl: expect.stringContaining('start=3'), reason: expect.stringMatching(/Page 3 was not read/) }); // prettier-ignore
    expect((await scan(id)).points[0].results).toHaveLength(3); // nothing collected was lost

    // Resume: the same page saved again (properly this time) continues the collection.
    const resumed = await add(id, [{ html: page({ start: 3, cards: [D] }) }]);
    expect(resumed.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', uniqueBusinesses: 4, pagesProcessed: 4 }); // prettier-ignore
    const rows = (await scan(id)).points[0].results as Row[];
    expect(rows.map((r) => [r.title, r.rank, r.batch])).toEqual([['Alpha Jewels', 1, 1], ['Beta Gold', 2, 1], ['Gamma Gems', 3, 2], ['Delta Diamonds', 4, 4]]); // prettier-ignore
  });

  it('stops successfully at the configured target, and does not read pages past it', async () => {
    const { start, add, scan } = await setup();
    const reached = await start([{ html: page({ cards: [A, B, C], next: 3 }) }, { html: page({ start: 3, cards: [D, E, F], next: 6 }) }], 4); // prettier-ignore
    expect(reached.body.data.progress).toMatchObject({ state: 'TARGET_REACHED', target: 4, uniqueBusinesses: 6, reason: expect.stringMatching(/reaching the target of 4/) }); // prettier-ignore
    const id = reached.body.data.scanId as string;
    expect(await scan(id)).toMatchObject({ status: 'SUCCEEDED', collectionStatus: 'successful' });
    expect((await add(id, [{ html: page({ start: 6, cards: [card('g7', 'Eta Jewels')] }) }])).status).toBe(
      409,
    );

    const early = await setup();
    const skipped = await early.start([{ html: page({ cards: [A, B, C], next: 3 }) }, { html: page({ start: 3, cards: [D], next: 4 }) }], 2); // prettier-ignore
    expect(skipped.body.data.progress).toMatchObject({ state: 'TARGET_REACHED', uniqueBusinesses: 3, pagesProcessed: 1 }); // prettier-ignore
    expect(skipped.body.data.limitations.join(' ')).toMatch(
      /1 page was not read: the collection had already ended/,
    );
  });

  it('can be stopped early (PARTIAL), does not block other scans, and is private to its workspace', async () => {
    const { client, projectId, queryId, start, add, scan } = await setup();
    const id = (await start([{ html: page({ cards: [A, B], next: 2 }) }])).body.data.scanId as string;
    // An open collection does not block a manual scan of the same query.
    expect((await client.post(`/projects/${projectId}/local/queries/${queryId}/scans`, { source: 'MANUAL' })).status).toBe(202); // prettier-ignore
    const outsider = await registerClient(app);
    expect((await outsider.client.post(`/projects/${projectId}/local/scans/${id}/google-capture/pages`, { pages: [{ html: page({ start: 2, cards: [C] }) }] })).status).toBe(404); // prettier-ignore
    expect((await outsider.client.post(`/projects/${projectId}/local/scans/${id}/google-capture/finish`)).status).toBe(404); // prettier-ignore
    // A page for another search is refused for that page, not stored.
    const other = await add(id, [{ html: page({ cards: [C] }).replaceAll(Q, 'jewellers in ahmedabad').replaceAll('best+jewellery+shop+in+surat', 'jewellers+in+ahmedabad') }]); // prettier-ignore
    expect(other.body.data.batches[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/collection is for “best jewellery shop in surat”/) }); // prettier-ignore

    const stopped = await client.post(`/projects/${projectId}/local/scans/${id}/google-capture/finish`);
    expect(stopped.body.data).toMatchObject({ state: 'PARTIAL', uniqueBusinesses: 2, reason: expect.stringMatching(/Stopped by you after 2 pages, with 2 unique businesses of the target 1000/) }); // prettier-ignore
    expect(await scan(id)).toMatchObject({ status: 'SUCCEEDED', collectionStatus: 'partial', captureProgress: { state: 'PARTIAL' } }); // prettier-ignore
    expect((await add(id, [{ html: page({ start: 2, cards: [C] }) }])).status).toBe(409);
    expect(await prisma.localRankScan.count({ where: { id, source: 'GOOGLE_CAPTURE' } })).toBe(1);
  });

  it('collects a whole Google Maps list from one file, and completes a list saved again further down', async () => {
    const MAPS = readFileSync(new URL('../../../packages/core/test/fixtures/google-maps-list.sample.html', import.meta.url), 'utf8'); // prettier-ignore
    const { start, add, scan } = await setup();
    // Saved at the end of its list: one upload is the whole collection.
    const whole = await start([{ html: MAPS }]);
    expect(whole.body.data).toMatchObject({ surface: 'maps', listings: 6, batches: [{ start: 0, offsetKnown: true, listings: 6, newListings: 6, sponsored: 1 }] }); // prettier-ignore
    expect(whole.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', uniqueBusinesses: 6, nextUrl: null, reason: expect.stringMatching(/^The Google Maps list was saved to its end.* 6 unique businesses/) }); // prettier-ignore
    const rows = (await scan(whole.body.data.scanId)).points[0].results as (Row & { sponsored?: boolean; entityId?: string })[]; // prettier-ignore
    expect(rows.map((r) => [r.rank, r.title, r.sponsored, r.cumulativePosition])).toEqual([
      [1, 'Nakrani Jewellers', false, 1],
      [2, 'shree radhe jewellers', false, 2],
      [3, 'Satani Gold', false, 3],
      [4, 'DAIVIK IMITATION JEWELLERY', false, 4],
      [5, 'CaratLane Jewellery Ghod Dod Road, Surat', true, 5],
      [6, 'Star Jewellers', false, 6],
    ]);

    // Saved before the end (4 cards), then again at the end: the second file adds only the rest, at their positions.
    const partial = MAPS.split('\n')
      .filter((line) => !/^<div role="article"><a aria-label="(CaratLane|Star Jewellers)/.test(line))
      .join('\n')
      .replace(/You['’]ve reached the end of the list\./, '');
    const first = await start([{ html: partial }]);
    expect(first.body.data.progress).toMatchObject({ state: 'IN_PROGRESS', uniqueBusinesses: 4 });
    const rest = await add(first.body.data.scanId, [{ html: MAPS }]);
    expect(rest.body.data.batches[0]).toMatchObject({ batch: 2, start: 0, listings: 6, newListings: 2, duplicates: 4 }); // prettier-ignore
    expect(rest.body.data.progress).toMatchObject({ state: 'SOURCE_EXHAUSTED', uniqueBusinesses: 6 });
    const all = (await scan(first.body.data.scanId)).points[0].results as Row[];
    expect(all.map((r) => [r.title, r.rank])).toEqual(rows.map((r) => [r.title, r.rank]));
  });
});
