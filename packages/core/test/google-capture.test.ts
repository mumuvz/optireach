// Google results page capture: address parsing and saved-page parsing. Most HTML below is SYNTHETIC test markup that
// follows the structure of Google's local results; it tests the parsing rules. The one exception is the fixture
// fixtures/google-places-udm-local.sample.html: a SANITISED EXTRACT of a real Places page saved in Chrome.
import { readFileSync } from 'node:fs';
import { compactSavedPage, decodeGoogleUule, parseGoogleSearchUrl } from '@surfaced/shared';
import { describe, expect, it } from 'vitest';
import {
  assignCapturePositions,
  captureIdentityKey,
  parseGoogleResultsHtml,
  uniqueBusinessCount,
  parseReviewCount,
  type CapturedListing,
} from '../src/local';

const PAGE_1 = `<!-- saved from url=(0093)https://www.google.com/search?q=best+jewellery+shop+in+surat&udm=local -->
<html><head><title>best jewellery shop in surat - Google Search</title><script>var x = '<div data-cid="99999999999999999999">';</script></head>
<body><div id="search">
  <div class="VkpGBb">
    <a data-cid="11111111111111111111" href="#"><div class="rllt__details">
      <div role="heading" aria-level="3"><span>Sponsored Gems</span></div>
      <div><span class="U3A9Ac">Sponsored</span></div>
      <div><span>4.2</span><span aria-label="Rated 4.2 out of 5,"></span><span>(310)</span> · Jewellery store</div>
    </div></a>
    <a href="https://sponsored-gems.example/" aria-label="Website"><div>Website</div></a>
  </div>
  <div class="VkpGBb">
    <a data-cid="22222222222222222222" href="#"><div class="rllt__details">
      <div role="heading"><span>Kalamandir Jewellers</span></div>
      <div><span>4.8</span><span>(34K)</span> · ₹₹ · Jewellery store</div>
      <div>10+ years in business · Ghod Dod Rd</div>
      <span data-cid="22222222222222222222">same listing, nested</span>
    </div></a>
    <a href="/url?q=https://www.kalamandir.example/&amp;sa=U"><div>Website</div></a>
    <a href="https://www.google.com/maps/place/Kalamandir/@21.19,72.82"><div>Directions</div></a>
  </div>
  <div class="VkpGBb">
    <a data-cid="33333333333333333333" href="#"><div>
      <div role="heading"><span>Rajmahal Jewellers</span></div>
      <div>No reviews · Jewellery store</div>
    </div></a>
  </div>
  <div class="VkpGBb"><a data-cid="22222222222222222222"><div role="heading">Kalamandir Jewellers</div></a></div>
</div></body></html>`;

describe('Google Search address parsing (nothing is fetched)', () => {
  it('reads the search, offset, surface and context of a Places results address', () => {
    const r = parseGoogleSearchUrl('https://www.google.com/search?q=best+jewellery+shop+in+surat&udm=local&start=20&hl=en&gl=in'); // prettier-ignore
    expect(r).toMatchObject({ ok: true, info: { query: 'best jewellery shop in surat', start: 20, hasStart: true, surface: 'places', language: 'en', country: 'in' } }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://www.google.co.in/search?q=x&tbm=lcl')).toMatchObject({ ok: true, info: { surface: 'places', start: 0, hasStart: false } }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://www.google.com/search?q=jewellers+surat')).toMatchObject({ ok: true, info: { surface: 'search' } }); // prettier-ignore
  });

  it('rejects addresses that are not Google Search results or a Google Maps search, with a reason', () => {
    expect(parseGoogleSearchUrl('https://www.google.com/maps/search/jewellers')).toMatchObject({ ok: true, info: { surface: 'maps', query: 'jewellers', mapCenter: null } }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://www.google.com/maps/dir/a/b')).toMatchObject({ ok: false, reason: expect.stringMatching(/Google Maps search/) }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://evil.example/search?q=x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a Google Search address/) }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://www.google.com/search?hl=en')).toMatchObject({ ok: false, reason: expect.stringMatching(/no search/) }); // prettier-ignore
    expect(parseGoogleSearchUrl('not a url')).toMatchObject({ ok: false });
  });

  it('decodes the canonical-name form of uule and refuses to guess other forms', () => {
    const b64 = Buffer.from('Surat,Gujarat,India').toString('base64');
    expect(decodeGoogleUule(`w+CAIQICIT${b64}`)).toBe('Surat,Gujarat,India');
    expect(decodeGoogleUule(`w CAIQICIT${b64}`)).toBe('Surat,Gujarat,India'); // "+" decoded to a space by the URL parser
    expect(decodeGoogleUule('a+cm9sZToxCnByb2R1Y2VyOjEy')).toBeNull();
    expect(parseGoogleSearchUrl(`https://www.google.com/search?q=x&uule=${encodeURIComponent(`w+CAIQICIT${b64}`)}`)).toMatchObject({ ok: true, info: { location: 'Surat,Gujarat,India' } }); // prettier-ignore
  });
});

describe('saved Google results page parsing', () => {
  it('keeps listings in page order, dedupes repeated renders, and reads only identifiable fields', () => {
    const page = parseGoogleResultsHtml(PAGE_1);
    expect(page.status).toBe('parsed');
    if (page.status !== 'parsed') return;
    // Order exactly as on the page; the best-rated listing is NOT promoted; the repeated Kalamandir render is dropped.
    expect(page.listings.map((l) => [l.position, l.title, l.sponsored])).toEqual([
      [1, 'Sponsored Gems', true],
      [2, 'Kalamandir Jewellers', false],
      [3, 'Rajmahal Jewellers', false],
    ]);
    expect(page.listings[0]).toMatchObject({ cid: '11111111111111111111', rating: 4.2, reviewCount: 310, category: 'Jewellery store', address: null, website: 'https://sponsored-gems.example/', domain: 'sponsored-gems.example', mapsUrl: 'https://maps.google.com/?cid=11111111111111111111', mapsUrlSource: 'place_id' }); // prettier-ignore
    // The line after the category line is the address; "10+ years in business" is not part of it.
    expect(page.listings[1]).toMatchObject({ rating: 4.8, reviewCount: 34_000, category: 'Jewellery store', address: 'Ghod Dod Rd', website: 'https://www.kalamandir.example/', domain: 'kalamandir.example', mapsUrl: 'https://www.google.com/maps/place/Kalamandir/@21.19,72.82', mapsUrlSource: 'page' }); // prettier-ignore
    // Not shown on the page → left empty, never filled in ("No reviews · Jewellery store" still gives the category).
    expect(page.listings[2]).toMatchObject({ rating: null, reviewCount: null, category: 'Jewellery store', website: null, address: null, latitude: null, longitude: null }); // prettier-ignore
    expect(page.savedFrom).toBe('https://www.google.com/search?q=best+jewellery+shop+in+surat&udm=local');
    expect(page.notes.join(' ')).toMatch(/abbreviated/);
    // Markup inside <script> is not treated as a listing.
    expect(page.listings.some((l) => l.cid === '99999999999999999999')).toBe(false);
  });

  it('reports Google’s consent and unusual-traffic pages as failed, and pages without listings as unavailable', () => {
    expect(parseGoogleResultsHtml('<html><title>Before you continue to Google</title><form action="https://consent.google.com/save"></form></html>')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/consent/) }); // prettier-ignore
    expect(parseGoogleResultsHtml('<html><body>Our systems have detected unusual traffic from your computer network.</body></html>')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/unusual traffic/) }); // prettier-ignore
    expect(parseGoogleResultsHtml('<html><title>best jewellery shop in surat - Google Search</title><body><div>web results only</div></body></html>')).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/No local business listings/) }); // prettier-ignore
    expect(parseGoogleResultsHtml('<html><title>Hello</title><body>nothing</body></html>')).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/does not look like/) }); // prettier-ignore
  });

  it('reads an MHTML (“save as single file”) archive, with the address and time the browser recorded', () => {
    const mhtml = [
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://www.google.com/search?q=qp+shop&udm=local',
      'Subject: qp shop - Google Search',
      'Date: Thu, 29 Oct 2026 10:15:00 -0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; type="text/html"; boundary="----MultipartBoundary--abc"',
      '',
      '------MultipartBoundary--abc',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html><head><title>qp shop - Google Search</title></head><body><div data-cid=3D"44444444444444444444"><d=',
      'iv role=3D"heading">QP Shop =E2=80=93 Surat</div></div></body></html>',
      '------MultipartBoundary--abc--',
    ].join('\r\n');
    const page = parseGoogleResultsHtml(mhtml);
    expect(page).toMatchObject({
      status: 'parsed',
      savedFrom: 'https://www.google.com/search?q=qp+shop&udm=local',
    });
    if (page.status !== 'parsed') return;
    expect(page.listings.map((l) => l.title)).toEqual(['QP Shop – Surat']);
    expect(page.savedAt?.toISOString()).toBe('2026-10-29T10:15:00.000Z');
  });

  it('parses review counts as displayed', () => {
    expect(parseReviewCount('34K')).toBe(34_000);
    expect(parseReviewCount('1.2K')).toBe(1_200);
    expect(parseReviewCount('1,234')).toBe(1_234);
    expect(parseReviewCount('n/a')).toBeNull();
  });
});

describe('real-save readiness (still SYNTHETIC markup)', () => {
  it('reads Chrome-style MHTML with folded headers, and compaction drops embedded resources without changing the result', () => {
    const mhtml = [
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://www.google.com/search?q=folded+shop&udm=local&start=10',
      'Subject: folded shop - Google Search',
      'Date: Thu, 29 Oct 2026 11:00:00 -0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related;',
      '\ttype="text/html";',
      '\tboundary="----MultipartBoundary--fold----"',
      '',
      '',
      '------MultipartBoundary--fold----',
      'Content-Type: text/html',
      'Content-ID: <frame-1@mhtml.blink>',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Location: https://www.google.com/search?q=folded+shop&udm=local&start=10',
      '',
      '<html><head><title>folded shop - Google Search</title></head><body><div data-cid=3D"55555555555555555555">=',
      '<div role=3D"heading"><span>Folded</span><span>Jewellers</span></div></div></body></html>',
      '------MultipartBoundary--fold----',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-Location: https://www.gstatic.com/logo.png',
      '',
      'iVBORw0KGgo'.repeat(5000),
      '------MultipartBoundary--fold------',
      '',
    ].join('\r\n');
    const compact = compactSavedPage(mhtml);
    expect(compact.length).toBeLessThan(mhtml.length / 10);
    expect(compact).not.toContain('image/png');
    for (const input of [mhtml, compact]) {
      const page = parseGoogleResultsHtml(input);
      expect(page).toMatchObject({ status: 'parsed', savedFrom: 'https://www.google.com/search?q=folded+shop&udm=local&start=10' }); // prettier-ignore
      if (page.status === 'parsed') expect(page.listings.map((l) => l.title)).toEqual(['Folded Jewellers']); // separate spans keep their space
    }
    expect(compactSavedPage('<html>plain</html>')).toBe('<html>plain</html>');
  });

  it('reports nested cards, repeated cards and listing-like blocks without a place ID', () => {
    const page = parseGoogleResultsHtml(PAGE_1);
    expect(page.status).toBe('parsed');
    if (page.status !== 'parsed') return;
    expect(page.diagnostics).toMatchObject({ placeIdElements: 5, nestedSameCard: 1, repeatedCards: 1, skippedWithoutName: 0, possibleMissed: [] }); // prettier-ignore
    const withMiss = parseGoogleResultsHtml(
      PAGE_1.replace('</div></body>', '<div class="x"><div role="heading">No Id Jewellers</div><div>4.5 (88) · Jewellery store</div></div></div></body>'), // prettier-ignore
    );
    expect(withMiss.status === 'parsed' && withMiss.diagnostics.possibleMissed).toEqual(['No Id Jewellers']);
    expect(withMiss.status === 'parsed' && withMiss.notes.join(' ')).toMatch(/carried no place ID and were not read: No Id Jewellers/); // prettier-ignore
  });
});

describe('capture positions across pages', () => {
  const listings = (n: number): CapturedListing[] =>
    Array.from({ length: n }, (_, i) => ({ position: i + 1, title: `B${i + 1}`, cid: null, entityId: null, placeId: null, rating: null, reviewCount: null, sponsored: false, category: null, address: null, website: null, domain: null, mapsUrl: null, mapsUrlSource: null, latitude: null, longitude: null })); // prettier-ignore

  it('derives global positions from each page’s own start= offset, without assuming page sizes', () => {
    const { positioned, notes } = assignCapturePositions([
      { batch: 1, info: { start: 0, hasStart: false }, listings: listings(10) },
      { batch: 2, info: { start: 10, hasStart: true }, listings: listings(3) },
    ]);
    expect(positioned.filter((p) => p.batch === 2).map((p) => [p.sourcePosition, p.cumulativePosition])).toEqual([[1, 11], [2, 12], [3, 13]]); // prettier-ignore
    expect(notes).toEqual([]);
  });

  it('keeps page-local positions when an offset cannot be established, and reports gaps and overlaps', () => {
    const local = assignCapturePositions([
      { batch: 1, info: { start: 0, hasStart: false }, listings: listings(2) },
      { batch: 2, info: { start: 0, hasStart: false }, listings: listings(2) },
    ]);
    expect(local.positioned.filter((p) => p.batch === 2).map((p) => p.cumulativePosition)).toEqual([
      null,
      null,
    ]);
    expect(local.notes.join(' ')).toMatch(/Page 2 has no start= .* page-local/);
    const gap = assignCapturePositions([
      { batch: 1, info: { start: 0, hasStart: false }, listings: listings(3) },
      { batch: 2, info: { start: 20, hasStart: true }, listings: listings(2) },
    ]);
    expect(gap.notes.join(' ')).toMatch(/Positions 4–20 were not captured/);
    const overlap = assignCapturePositions([
      { batch: 1, info: { start: 0, hasStart: false }, listings: listings(20) },
      { batch: 2, info: { start: 10, hasStart: true }, listings: listings(20) },
    ]);
    expect(overlap.notes.join(' ')).toMatch(/Pages 1 and 2 overlap \(positions 11–20/);
  });
});

describe('real saved Google Places page (sanitised extract, udm=local layout)', () => {
  // A real page saved in Chrome for "best jewellery shop in nana varachha surat": 4 of its 20 cards, classes and
  // tracking removed, phones zeroed. Listings carry no data-cid there; each card has a Knowledge Graph entity ID.
  const REAL = readFileSync(
    new URL('./fixtures/google-places-udm-local.sample.html', import.meta.url),
    'utf8',
  );

  it('reads every card by its entity ID, in page order, without depending on CSS classes', () => {
    const page = parseGoogleResultsHtml(REAL);
    expect(page.status).toBe('parsed'); // Google's own "/sorry/index" check in a script is not a block page
    if (page.status !== 'parsed') return;
    expect(page.listings.map((l) => [l.position, l.title, l.entityId, l.sponsored])).toEqual([
      [1, 'shree radhe jewellers', '/g/11fk2bz1w2', false],
      [2, 'Nakrani Gold - Jewellery Shop Yogi chowk, Surat', '/g/11m415vtmr', false],
      [3, 'Zaver Jewellers', '/g/11z754k0g6', false],
      [4, 'Rajshri Jewellers - Chikuwadi', '/g/11x0pd2tvn', false],
    ]);
    expect(page.listings.map((l) => [l.rating, l.reviewCount, l.category])).toEqual([
      [4.9, 618, 'Jewelry store'], // exact, from "Rated 4.9 out of 5, 618 user reviews"
      [4.8, 1_000, 'Jewelry store'], // "1K" as displayed
      [5, 26, 'Costume jewelry shop'],
      [4.9, 1_100, 'Jewelry store'], // "1.1K" as displayed
    ]);
    // The address line as the card shows it, phone removed; a line without a phone is kept whole.
    expect(page.listings.map((l) => l.address)).toEqual([
      '8',
      '13 Krishna Rowhouse Savalia Cir, Yogi Chowk Rd, opposite Apple Square',
      'Rio Business Hub, 305, near yamuna chowk',
      'opp. Ashadeep School -3',
    ]);
    // The page carries no website, Maps link or CID for these cards: left empty, not built.
    expect(page.listings.every((l) => l.website === null && l.mapsUrl === null && l.mapsUrlSource === null && l.cid === null)).toBe(true); // prettier-ignore
    // The feedback dialog's heading is not a listing; nothing was duplicated, skipped or missed.
    expect(page.diagnostics).toMatchObject({ placeIdElements: 4, nestedSameCard: 0, repeatedCards: 0, skippedWithoutName: 0, rejectedNotListing: 0, possibleMissed: [] }); // prettier-ignore
    expect(page.notes.join(' ')).toMatch(/2 review counts were abbreviated/);
    // The card's other lines: whether a phone is shown (the number is not kept), hours as shown, service options.
    expect(page.listings.map((l) => [l.phoneShown, l.hours, l.serviceOptions, l.reviewSnippet])).toEqual([
      [true, 'Open · Closes 8:30 pm', ['In-store shopping', 'Delivery'], null],
      [true, 'Open · Closes 8:30 pm', ['In-store shopping', 'Kerbside pickup', 'Delivery'], null],
      [false, 'Open · Closes 6 pm', ['Delivery', 'No in-store shopping'], null],
      [true, 'Open · Closes 8 pm', ['In-store shopping', 'Delivery'], null],
    ]);
    expect(page.savedFrom).toBe(
      'https://www.google.com/search?q=best+jewellery+shop+in+nana+varachha+surat&udm=local',
    );
  });

  it('classifies the udm=local address of "More places" as the Places view', () => {
    expect(parseGoogleSearchUrl('https://www.google.com/search?q=best+jewellery+shop+in+nana+varachha+surat&udm=local&sa=X')).toMatchObject({ ok: true, info: { surface: 'places', start: 0, hasStart: false } }); // prettier-ignore
  });

  it('reads a customer quote, and ignores lines about whoever saved the page', () => {
    const page = parseGoogleResultsHtml(
      '<html><title>q - Google Search</title><body>' +
        '<div id="pv-/g/11aaaaaaaa" role="button"><div><div role="heading">Quote Gems</div><div>4.9(361) · Jeweler</div><div>Ring Rd · 097142 88839</div><div>Open · Closes 8 pm</div><div>"Best service very nice collection"</div></div></div>' + // prettier-ignore
        '<div id="pv-/g/11bbbbbbbb" role="button"><div><div role="heading">Viewed Gold</div><div>4.9(35K) · Jewelry store</div><div>Ghod Dod Rd</div><div>Open 24 hours</div><div>Viewed 2 days ago</div></div></div>' + // prettier-ignore
        '</body></html>',
    );
    if (page.status !== 'parsed') throw new Error(page.status);
    expect(page.listings.map((l) => [l.phoneShown, l.hours, l.serviceOptions, l.reviewSnippet])).toEqual([
      [true, 'Open · Closes 8 pm', [], 'Best service very nice collection'],
      [false, 'Open 24 hours', [], null],
    ]);
  });

  it('rejects an entity-ID card that shows no listing details', () => {
    const page = parseGoogleResultsHtml('<html><title>x - Google Search</title><body><div id="pv-/g/11abcdefgh"><div role="heading">Some Topic</div></div></body></html>'); // prettier-ignore
    expect(page).toMatchObject({ status: 'unavailable', diagnostics: { rejectedNotListing: 1 } });
  });
});

describe('continuation and identity (SYNTHETIC markup)', () => {
  it('reads Google’s own next-page link, ignores injected "Next" labels, and finds "More places"', () => {
    const places = parseGoogleResultsHtml(
      '<html><title>q - Google Search</title><body><div id="pv-/g/11aaaaaaaa" role="button"><div><div role="heading">Shop</div><div>4.5 (10) · Jewelry store</div></div></div>' +
        '<div role="complementary" aria-label="NextRaise AI application agent"></div>' + // a browser extension's element
        '<a id="pnnext" href="/search?q=q&amp;udm=local&amp;start=20"><span>Next</span></a></body></html>',
    );
    expect(places.status === 'parsed' && places.continuation).toEqual({ nextPageUrl: 'https://www.google.com/search?q=q&udm=local&start=20', morePlacesUrl: null }); // prettier-ignore
    const main = parseGoogleResultsHtml(
      '<html><title>q - Google Search</title><body><div data-cid="12345678901234567"><div role="heading">Shop</div></div>' +
        '<a href="/search?q=q&amp;udm=local&amp;sa=X">More places</a><a id="pnnext" href="/search?q=q&amp;start=10">Next</a></body></html>',
    );
    expect(main.status === 'parsed' && main.continuation).toEqual({ nextPageUrl: 'https://www.google.com/search?q=q&start=10', morePlacesUrl: 'https://www.google.com/search?q=q&udm=local&sa=X' }); // prettier-ignore
  });

  it('recognises a business by entity ID, then CID, then name + address, and never merges listings with none', () => {
    expect(captureIdentityKey({ entityId: '/g/1', cid: '123', title: 'A', address: 'X' })).toBe('e:/g/1');
    expect(captureIdentityKey({ cid: '123', title: 'A', address: 'X' })).toBe('c:123');
    // Name + address fallback: case and punctuation do not matter; another address is another business.
    const key = captureIdentityKey({ title: 'Alpha Jewels', address: 'Ring Rd, Surat' });
    expect(key).not.toBeNull();
    expect(captureIdentityKey({ title: 'ALPHA JEWELS', address: 'Ring Rd Surat' })).toBe(key);
    expect(captureIdentityKey({ title: 'Alpha Jewels', address: 'Station Rd, Surat' })).not.toBe(key);
    expect(captureIdentityKey({ title: 'Same Name' })).toBeNull();
    const row = (title: string, extra: Record<string, unknown> = {}) => ({ rank: 1, title, placeId: null, cid: null, domain: null, category: null, rating: null, reviewCount: null, address: null, latitude: null, longitude: null, isTarget: false, competitorId: null, ...extra }); // prettier-ignore
    // An ad and an organic listing of the same business count once; listings without identity each count.
    expect(uniqueBusinessCount([row('A', { entityId: '/g/1', sponsored: true }), row('A', { entityId: '/g/1', sponsored: false }), row('B'), row('B')])).toBe(3); // prettier-ignore
  });
});

describe('the page’s own listing data (SYNTHETIC, in the structure of real saved Places pages)', () => {
  // A real page's scripts carry `var m={…}`: per listing an entry with the ID tuple, the rating record and the
  // "Suggest an edit" fields; map pins sit in another entry. Names, IDs and numbers below are made up.
  const fid = (cid: string) => `0x3be04f0000000000:0x${BigInt(cid).toString(16)}`;
  const edit = (value: string, id: number, label: string) => [value, id, 1, 1, [1, null, 0], label];
  type Place = { name: string; cid: string; entityId: string; placeId: string; reviews: number; address: string; phone: string; website: string }; // prettier-ignore
  const entry = (o: Place, featureId = fid(o.cid)) => {
    const fields = [edit(o.name, 772642124, 'Place name'), edit('Jewelry store', 1009507392, 'Place category'), edit(o.address, 1188690564, 'Place location'), edit(o.phone, 108170089, 'Place phone number'), edit(o.website, 1820148960, 'Place website')]; // prettier-ignore
    const suggestEdit = [null, null, null, null, [null, null, null, null, 'Suggest an edit', [], 'https://www.google.com/local/place/rap/edit', featureId, 'un'], fields]; // prettier-ignore
    const profile = { 498469725: [o.name, [4.8000001907, null, null, [o.reviews]], null, [[null, ['Jewelry store']]], null, null, suggestEdit] }; // prettier-ignore
    const ids = { 508231533: [[featureId, o.cid, null, o.entityId, o.placeId, '1']] };
    return ['/searchviewer/10', null, o.cid, null, 'token', 5, null, null, o.entityId, [[{ 512247391: [] }], [[[[profile]], [[ids]]]]]]; // prettier-ignore
  };
  const pin = (cid: string, lat: number, lng: number) => ({ 182: [null, null, null, Math.round(lat * 1e6), Math.round(lng * 1e6), { 32: ['1', cid], 44: 'gcid:jewelry_store' }] }); // prettier-ignore
  const card = (entityId: string, name: string, lines: string[]) =>
    `<div id="pv-${entityId}" role="button"><div><div role="heading">${name}</div>${lines.map((l) => `<div>${l}</div>`).join('')}</div></div>`; // prettier-ignore
  const page = (cards: string[], model: Record<string, unknown>, title = 'jewellers - Google Search') =>
    `<html><head><title>${title}</title></head><body>${cards.join('')}<script nonce="">(function(){var m=${JSON.stringify(model)};var a=m;})();</script></body></html>`; // prettier-ignore

  const ALPHA = { name: 'Alpha Jewellers', cid: '1111111111111111111', entityId: '/g/11alpha0001', placeId: 'ChIJalpha00000000000000001', reviews: 1008, address: '12, Ring Road, Nana Varachha, Surat, Gujarat 395013', phone: '000000 00000', website: 'https://www.instagram.com/alpha_jewellers?igsh=abc' }; // prettier-ignore
  const BETA = { name: 'Beta Gold', cid: '2222222222222222222', entityId: '/g/11beta00002', placeId: 'ChIJbeta000000000000000002', reviews: 245, address: '4, Station Road, Surat, Gujarat 395003', phone: 'Add phone number', website: 'Add website' }; // prettier-ignore
  const GAMMA = { name: 'Gamma Jewels', cid: '3333333333333333333', entityId: '/g/11gamma0003', placeId: 'ChIJgamma00000000000000003', reviews: 2500, address: '9, Main Road, Surat, Gujarat 395007', phone: '000000 00001', website: 'https://gamma.example/' }; // prettier-ignore

  it('fills IDs, exact review counts, full addresses, websites and coordinates from the data, matched by entity ID', () => {
    const html = page(
      [
        card(ALPHA.entityId, 'Alpha Jewellers', ['4.8(1K) · Jewelry store', '12 · 097142 00000', 'Open · Closes 8 pm']), // prettier-ignore
        card(BETA.entityId, 'Beta Gold', ['4.8(245) · Jewelry store', 'Station Rd', 'Open · Closes 9 pm']),
        card(GAMMA.entityId, 'Gamma Jewels', ['4.8(1K) · Jewelry store', 'Main Rd · 097142 00001', 'Open · Closes 8 pm']), // prettier-ignore
      ],
      { k25: entry(ALPHA), k26: entry(BETA), k27: entry(GAMMA), k12: [[pin(ALPHA.cid, 21.222182, 72.889241), pin(BETA.cid, 21.214335, 72.887908)]] }, // prettier-ignore
    );
    const result = parseGoogleResultsHtml(html);
    if (result.status !== 'parsed') throw new Error(result.status);
    const [alpha, beta, gamma] = result.listings;
    expect(alpha).toMatchObject({
      cid: ALPHA.cid,
      placeId: ALPHA.placeId,
      mapsUrl: `https://maps.google.com/?cid=${ALPHA.cid}`,
      mapsUrlSource: 'place_id',
      reviewCount: 1008, // the card showed "1K"
      address: ALPHA.address, // the card showed "12"
      website: ALPHA.website,
      domain: null, // an Instagram page never identifies the business as a domain
      websiteListed: true,
      latitude: 21.222182,
      longitude: 72.889241,
      phoneShown: true,
    });
    expect(beta).toMatchObject({ websiteListed: false, website: null, domain: null, phoneShown: false, latitude: 21.214335 }); // prettier-ignore
    // 2,500 cannot be what "1K" was rounded from: the card's count is kept.
    expect(gamma).toMatchObject({ reviewCount: 1000, domain: 'gamma.example', latitude: null });
    expect(result.diagnostics.embedded).toEqual({ places: 3, matched: 3, nameMismatch: 0, notOnCards: [], coordinates: 2, exactReviewCounts: 1, websites: 2 }); // prettier-ignore
    expect(result.notes).toEqual([
      'All 3 businesses in this file were read (the result cards, checked against the page’s own data). A saved results page holds only that page’s results.', // prettier-ignore
      'From the page’s own data: exact review counts for 1 shown rounded, Google’s place IDs for 3, map coordinates for 2, websites for 2.', // prettier-ignore
      '1 review count was abbreviated by Google (for example “34K”) and is stored as displayed, so rounded.',
    ]);
  });

  it('uses no data under another name, never adds a business that is not a card, and rejects look-alike IDs', () => {
    // The CID is not the feature ID's second half: not one of Google's ID tuples.
    const fake = entry({ ...GAMMA, entityId: '/g/11fake0004', name: 'Fake Tuple' }, '0x1:0x2');
    const html = page(
      [
        card(ALPHA.entityId, 'Alpha Jewellers Surat', ['4.8(1K) · Jewelry store', '12 · 097142 00000']),
        card(BETA.entityId, 'Beta Gold', ['4.8(245) · Jewelry store', 'Station Rd']),
      ],
      { k25: entry(ALPHA), k26: entry(BETA), k27: entry(GAMMA), k28: fake },
    );
    const result = parseGoogleResultsHtml(html);
    if (result.status !== 'parsed') throw new Error(result.status);
    expect(result.listings.map((l) => [l.title, l.cid, l.reviewCount])).toEqual([
      ['Alpha Jewellers Surat', null, 1000], // same entity ID, different name: the data is not used
      ['Beta Gold', BETA.cid, 245],
    ]);
    expect(result.diagnostics.embedded).toMatchObject({ places: 3, matched: 1, nameMismatch: 1, notOnCards: ['Gamma Jewels'] }); // prettier-ignore
    expect(result.notes[0]).toMatch(/^The file holds 3 businesses: 2 result cards were read; 1 more appear only in the page’s data \(Gamma Jewels\) and were not added/); // prettier-ignore
  });

  it('says how to save a Google Maps page that shows no results list', () => {
    const maps = parseGoogleResultsHtml('<html><head><title>jewellers - Google Maps</title></head><body><div role="feed"></div></body></html>'); // prettier-ignore
    expect(maps).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/^This saved Google Maps page shows no results list/) }); // prettier-ignore
  });
});

describe('real saved Google Maps list (sanitised extract)', () => {
  // A real Maps search saved in Chrome with its list scrolled to the end (121 listings): 6 of its cards, classes,
  // tracking, images and link parameters removed, phones zeroed.
  const MAPS = readFileSync(new URL('./fixtures/google-maps-list.sample.html', import.meta.url), 'utf8');
  const URL_RECORDED = 'https://www.google.com/maps/search/jewellery+shop+in+nana+varachha+surat/@21.2404147,72.8869927,8104m/data=!3m1!1e3!4m2!2m1!6e6?entry=ttu&g_ep=EgoyMDI2MTAyNy4wIKXMDSoASAFQAw%3D%3D'; // prettier-ignore

  it('reads a Google Maps search address: the search, one list from #1, and the map centre', () => {
    expect(parseGoogleSearchUrl(URL_RECORDED)).toMatchObject({ ok: true, info: { query: 'jewellery shop in nana varachha surat', surface: 'maps', start: 0, hasStart: true, location: null, mapCenter: { latitude: 21.2404147, longitude: 72.8869927 } } }); // prettier-ignore
    expect(parseGoogleSearchUrl('https://www.google.com/maps/place/Nakrani+Jewellers/data=!4m7')).toMatchObject({ ok: false, reason: expect.stringMatching(/Google Maps search/) }); // prettier-ignore
  });

  it('reads every card in list order, with Google’s IDs and coordinates from its place link', () => {
    const page = parseGoogleResultsHtml(MAPS);
    if (page.status !== 'parsed') throw new Error(page.status);
    expect(page.savedFrom).toBe(URL_RECORDED);
    expect(
      page.listings.map((l) => [l.position, l.title, l.sponsored, l.rating, l.reviewCount, l.category]),
    ).toEqual([
      [1, 'Nakrani Jewellers', false, 4.8, 246, 'Jewelry store'],
      [2, 'shree radhe jewellers', false, 4.9, 618, 'Jewelry store'],
      [3, 'Satani Gold', false, 4.9, 81, 'Jewelry store'],
      [4, 'DAIVIK IMITATION JEWELLERY', false, 5, 16, 'Jewelry store'],
      [5, 'CaratLane Jewellery Ghod Dod Road, Surat', true, 4.9, 2024, 'Jewellery Store'], // the list's one ad
      [6, 'Star Jewellers', false, 5, 9, 'Jewelry store'],
    ]);
    // The same business as on the Google Search pages: entity ID, CID (the feature ID's second half) and Place ID.
    expect(page.listings[1]).toMatchObject({
      entityId: '/g/11fk2bz1w2',
      cid: '8850093683720681684',
      placeId: 'ChIJ9chNZ2dP4DsR1HgZx1DZ0Xo',
      latitude: 21.2221822,
      longitude: 72.8892405,
      mapsUrlSource: 'page',
      mapsUrl: expect.stringMatching(
        /^https:\/\/www\.google\.com\/maps\/place\/shree\+radhe\+jewellers\/data=/,
      ),
      website: null,
    });
    // Addresses as the card shortens them; the wheelchair icon glyph is not part of it; one card shows none.
    expect(page.listings.map((l) => l.address)).toEqual(['YAMUNA CHOWK, Yamuna Palace', '8', 'Shabri Dham Society, 55, near Shreenidhi Residency, opp. Axis Bank', 'Sumeru city mall, A-66', 'Ghod Dod Rd, 13A, Plot', null]); // prettier-ignore
    expect(page.listings.map((l) => [l.phoneShown, l.hours, l.serviceOptions, l.reviewSnippet])).toEqual([
      [true, 'Open · Closes 9 pm', ['In-store shopping', 'In-store pick-up', 'Delivery'], null],
      [true, 'Open · Closes 8:30 pm', ['In-store shopping', 'Delivery'], null],
      [true, 'Open · Closes 8 pm', ['In-store pick-up', 'Delivery'], null],
      [true, null, [], 'The quality is great and the jewellery is very comfortable to wear.'], // a phone-only line
      [true, 'Open · Closes 9:30 pm', ['In-store shopping', 'In-store pick-up', 'Delivery'], null],
      [true, 'Open · Closes 8:30 pm', ['Delivery'], null],
    ]);
    expect(page.continuation).toEqual({ nextPageUrl: null, morePlacesUrl: null, listEnd: true });
    expect(page.notes[0]).toMatch(/^Google Maps list: 6 businesses, saved to the end of the list\./);
    expect(page.diagnostics).toMatchObject({ placeIdElements: 6, repeatedCards: 0, rejectedNotListing: 0 });
  });

  it('says so when the list was not saved at its end', () => {
    const page = parseGoogleResultsHtml(MAPS.replace(/You['’]ve reached the end of the list\./, ''));
    if (page.status !== 'parsed') throw new Error(page.status);
    expect(page.continuation.listEnd).toBe(false);
    expect(page.notes.join(' ')).toMatch(/not saved at its end .* Scroll the list to its end and save the page again/); // prettier-ignore
  });
});
