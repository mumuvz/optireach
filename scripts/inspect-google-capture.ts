// Runs OptiReach's Google page-capture parser on pages you saved from your own browser and prints what it extracts.
// It reads local files only and never requests Google. Use it to validate the parser against real saved pages.
//
//   npx tsx scripts/inspect-google-capture.ts <saved-page> [<page-address>] [<saved-page-2> [<page-address-2>]] [--json]
//
// Each file may be followed by the google.com/search?… address it was saved from (needed for page 2+ offsets when the
// browser did not record it). Pages are taken in the order given (page 1 first).
import { readFileSync, statSync } from 'node:fs';
import { compactSavedPage, parseGoogleSearchUrl } from '@surfaced/shared';
import {
  assignCapturePositions,
  parseGoogleResultsHtml,
  type CapturedListing,
} from '../packages/core/src/local/google-capture';

const args = process.argv.slice(2);
const json = args.includes('--json');
const pages: { file: string; url: string | null }[] = [];
for (const arg of args.filter((a) => a !== '--json')) {
  if (/^https?:\/\//i.test(arg) && pages.length) pages[pages.length - 1]!.url = arg;
  else pages.push({ file: arg, url: null });
}
if (!pages.length) {
  console.error('Usage: npx tsx scripts/inspect-google-capture.ts <saved-page> [<page-address>] [<saved-page-2> [<page-address-2>]] [--json]'); // prettier-ignore
  process.exit(1);
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const cell = (v: unknown, width: number) => {
  const s = v === null || v === undefined || v === '' ? '—' : String(v);
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
};
const FIELDS: (keyof CapturedListing)[] = ['rating', 'reviewCount', 'category', 'address', 'website', 'mapsUrl', 'cid', 'entityId', 'placeId', 'latitude']; // prettier-ignore

const parsedPages: {
  batch: number;
  info: { start: number; hasStart: boolean };
  listings: CapturedListing[];
}[] = [];
const report: unknown[] = [];

pages.forEach((page, i) => {
  const batch = i + 1;
  const raw = readFileSync(page.file, 'utf8');
  const compact = compactSavedPage(raw);
  const result = parseGoogleResultsHtml(compact);
  const address = page.url ?? result.savedFrom;
  const info = address ? parseGoogleSearchUrl(address) : null;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(compact.slice(0, 500_000))?.[1]?.trim() ?? null;
  report.push({ batch, file: page.file, address, info, result });
  if (json) {
    if (result.status === 'parsed' && info?.ok)
      parsedPages.push({ batch, info: info.info, listings: result.listings });
    return;
  }

  console.log(`\n=== Page ${batch}: ${page.file} ===`);
  console.log(`File: ${kb(statSync(page.file).size)}${compact.length < raw.length ? ` (MHTML; embedded resources dropped → ${kb(compact.length)} read)` : ''}`); // prettier-ignore
  console.log(`Page title: ${title ?? '(none)'}`);
  console.log(`Address recorded by the browser: ${result.savedFrom ?? '(not recorded)'}`);
  console.log(`Saved at (from the file): ${result.savedAt?.toISOString() ?? '(not recorded)'}`);
  if (page.url && result.savedFrom && page.url !== result.savedFrom)
    console.log(`Address given: ${page.url}`);
  if (!info) console.log('Address: none given or recorded → positions on this page are page-local.');
  else if (!info.ok) console.log(`Address INVALID: ${info.reason}`);
  else
    console.log(`Search: “${info.info.query}” · ${info.info.surface} · offset start=${info.info.start}${info.info.hasStart ? ' (from the address)' : ' (no start= → first page assumed only if this is page 1)'}${info.info.location ? ` · location ${info.info.location}` : ''}`); // prettier-ignore

  if (result.status === 'failed') {
    console.log(`Status: FAILED — ${result.reason}`);
    return;
  }
  const d = result.diagnostics;
  if (result.status === 'unavailable') {
    console.log(`Status: UNAVAILABLE — ${result.reason}`);
  } else {
    if (info?.ok) parsedPages.push({ batch, info: info.info, listings: result.listings });
    const n = result.listings.length;
    console.log(`Status: PARSED — ${n} listing${n === 1 ? '' : 's'}\n`);
    console.log(`${cell('Pos', 4)} ${cell('Business', 44)} ${cell('Type', 9)} ${cell('Rating', 6)} ${cell('Reviews', 8)} ${cell('Category', 20)} ${cell('Website', 24)}`); // prettier-ignore
    for (const l of result.listings)
      console.log(`${cell(l.position, 4)} ${cell(l.title, 44)} ${cell(l.sponsored ? 'Sponsored' : 'Organic', 9)} ${cell(l.rating?.toFixed(1), 6)} ${cell(l.reviewCount, 8)} ${cell(l.category, 20)} ${cell(l.domain, 24)}`); // prettier-ignore
    console.log('\nAddress (the profile’s full address from the page’s data, else as the card shows it):');
    for (const l of result.listings)
      console.log(`  ${String(l.position).padStart(2)}. ${l.address ?? '— (not shown)'}`);
    console.log('\nIdentifiers and links:');
    for (const l of result.listings) {
      const ids = [l.entityId ? `entity ${l.entityId}` : null, l.cid ? `CID ${l.cid}` : null, l.placeId ? `Place ID ${l.placeId}` : null].filter(Boolean).join(' · ') || '— (no identifier)'; // prettier-ignore
      const maps = l.mapsUrl ? `${l.mapsUrl} (${l.mapsUrlSource === 'page' ? 'link on the page' : 'built from the CID'})` : 'no Maps link on this page'; // prettier-ignore
      console.log(`  ${String(l.position).padStart(2)}. ${ids} · Maps: ${maps}`);
    }
    console.log('\nProfile details shown on the card (phone · hours · service options · review quote):');
    for (const l of result.listings) {
      const parts = l.phoneShown === undefined ? ['(not read from this layout)'] : [l.phoneShown ? 'phone' : 'no phone', l.hours ?? 'no hours', l.serviceOptions?.length ? l.serviceOptions.join(', ') : 'no service options', l.reviewSnippet ? `“${l.reviewSnippet}”` : null].filter(Boolean); // prettier-ignore
      console.log(`  ${String(l.position).padStart(2)}. ${parts.join(' · ')}`);
    }
    console.log('\nWebsite and map pin (from the page’s own data):');
    for (const l of result.listings) {
      const site = l.websiteListed === undefined ? 'website: not in the data' : l.websiteListed ? `website ${l.website}` : 'no website on the profile'; // prettier-ignore
      const pin = l.latitude !== null ? `${l.latitude}, ${l.longitude}` : 'no coordinates';
      console.log(`  ${String(l.position).padStart(2)}. ${site} · ${pin}`);
    }
    const e = d.embedded;
    console.log('\nWhat the file holds:');
    console.log(`  result cards read: ${n}`);
    console.log(`  businesses in the page’s own data: ${e.places} (matched to a card ${e.matched} · same ID, different name ${e.nameMismatch} · not on any card ${e.notOnCards.length})`); // prettier-ignore
    if (e.notOnCards.length) console.log(`  in the data only (not added, no position shown): ${e.notOnCards.join(' | ')}`); // prettier-ignore
    console.log(`  businesses in the file in total: ${n + e.notOnCards.length} · beyond the visible cards: ${e.notOnCards.length}`); // prettier-ignore
    console.log(`  filled from the data: exact review counts ${e.exactReviewCounts} · coordinates ${e.coordinates} · websites ${e.websites}`); // prettier-ignore
    console.log('\nMissing fields (not shown on the page or not identifiable):');
    for (const f of FIELDS) {
      const missing = result.listings.filter((l) => l[f] === null || l[f] === undefined).length;
      const none = f === 'website' ? result.listings.filter((l) => l.websiteListed === false).length : 0;
      if (missing) console.log(`  ${String(f).padEnd(12)} ${missing}/${n}${none ? ` (${none} of them list no website on the profile)` : ''}`); // prettier-ignore
    }
    for (const note of result.notes) console.log(`Note: ${note}`);
  }
  // Continuation links from the page itself (session parameters omitted from the printout).
  const brief = (u: string | null) => {
    if (!u) return 'none on this page';
    const p = new URL(u);
    return `/search?q=${p.searchParams.get('q')}${p.searchParams.get('udm') ? `&udm=${p.searchParams.get('udm')}` : ''}${p.searchParams.get('tbm') ? `&tbm=${p.searchParams.get('tbm')}` : ''}${p.searchParams.get('start') ? `&start=${p.searchParams.get('start')}` : ''} (+ Google session parameters)`; // prettier-ignore
  };
  console.log('\nContinuation (from the page itself):');
  console.log(`  next page (#pnnext): ${brief(result.continuation.nextPageUrl)}`);
  console.log(`  “More places” view:  ${brief(result.continuation.morePlacesUrl)}`);
  console.log('\nDiagnostics:');
  console.log(`  identifier elements ${d.placeIdElements} · nested in the same card ${d.nestedSameCard} · repeated cards kept once ${d.repeatedCards} · skipped (no name) ${d.skippedWithoutName} · rejected (not a listing) ${d.rejectedNotListing}`); // prettier-ignore
  console.log(`  signals: headings ${d.signals.headings} · rating values ${d.signals.ratingValues} · ludocid links ${d.signals.ludocidLinks} · /maps/place/ links ${d.signals.mapsPlaceLinks} · lrd links ${d.signals.lrdLinks}`); // prettier-ignore
  console.log(`  possibly missed (heading + rating, no place ID): ${d.possibleMissed.length ? d.possibleMissed.join(' | ') : 'none'}`); // prettier-ignore
});

if (parsedPages.length) {
  const { positioned, notes } = assignCapturePositions(parsedPages);
  if (json) {
    console.log(JSON.stringify({ pages: report, positions: positioned.map((p) => ({ batch: p.batch, sourcePosition: p.sourcePosition, cumulativePosition: p.cumulativePosition, title: p.listing.title, cid: p.listing.cid, sponsored: p.listing.sponsored })), notes }, null, 2)); // prettier-ignore
  } else if (pages.length > 1) {
    console.log('\n=== Overall positions (as OptiReach would store them) ===');
    for (const p of positioned)
      console.log(`  ${p.cumulativePosition === null ? `page ${p.batch} #${p.sourcePosition} (page-local)` : `#${p.cumulativePosition}`.padEnd(8)}  page ${p.batch} · #${p.sourcePosition} on page · ${p.listing.title}`); // prettier-ignore
    for (const note of notes) console.log(`Note: ${note}`);
  }
} else if (json) console.log(JSON.stringify({ pages: report, positions: [], notes: [] }, null, 2));
