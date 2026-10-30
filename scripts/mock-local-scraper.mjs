// DEMO ONLY — a stand-in for your own local-search collection service, to test the SERP_PROVIDER=custom connector.
// It returns a FIXED, deliberately out-of-rating-order list so you can verify OptiReach preserves the order exactly
// (it must NOT re-sort by rating/distance). This returns fake data — it does not collect anything from Google.
//
// Run:   node scripts/mock-local-scraper.mjs
// Then set in .env:  SERP_PROVIDER=custom   CUSTOM_SERP_URL=http://127.0.0.1:4600/collect
// Restart the API + worker, then "Scan now" in the Rank tracker.
import { createServer } from 'node:http';

// This server only returns fake data. Refuse to run in production so it can never be mistaken for a real collector.
if (process.env.NODE_ENV === 'production') {
  console.error(
    'mock-local-scraper is a DEMO tool that returns fake data and must not run in production. Aborting.',
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 4600;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let q = {};
    try {
      q = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    const lat = typeof q.latitude === 'number' ? q.latitude : 21.17;
    const lng = typeof q.longitude === 'number' ? q.longitude : 72.83;
    // A sponsored listing sits on top (flagged, NOT counted as an organic win); the best-rated organic result is at
    // organic position 2 on purpose — OptiReach must keep it there, not promote it by rating. A second batch is
    // returned and declared continuous, so positions continue 1..n across batches instead of being invented here.
    const results = [
      {
        title: 'Paid Jeweller',
        sponsored: true,
        batch: 1,
        sourcePosition: 1,
        domain: 'paid-jeweller.example',
        rating: 4.0,
        reviewCount: 50,
        latitude: lat + 0.0012,
        longitude: lng,
      },
      {
        title: 'Jeweller A',
        sponsored: false,
        batch: 1,
        sourcePosition: 2,
        domain: 'jeweller-a.example',
        rating: 3.9,
        reviewCount: 120,
        latitude: lat + 0.001,
        longitude: lng,
      },
      {
        title: 'Rajmahal Jewellers',
        sponsored: false,
        batch: 1,
        sourcePosition: 3,
        domain: 'rajmahal.example',
        rating: 4.9,
        reviewCount: 9000,
        latitude: lat,
        longitude: lng + 0.001,
      },
      {
        title: 'Jeweller C',
        sponsored: false,
        batch: 2,
        sourcePosition: 1,
        domain: 'jeweller-c.example',
        rating: 4.2,
        reviewCount: 300,
        latitude: lat - 0.001,
        longitude: lng,
      },
    ];
    console.log(
      `collect: "${q.query ?? ''}" @ ${lat},${lng} (${q.surface ?? 'MAPS'}) -> ${results.length} results`,
    );
    res.setHeader('content-type', 'application/json');
    // observationType + continuous are part of the contract OptiReach understands.
    res.end(
      JSON.stringify({
        results,
        continuous: true,
        observationType: 'observed_search_position',
        collectedAt: new Date().toISOString(),
      }),
    );
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Mock local scraper listening on http://127.0.0.1:${PORT}/collect`);
  console.log(
    'Set SERP_PROVIDER=custom and CUSTOM_SERP_URL=http://127.0.0.1:4600/collect, then restart API + worker.',
  );
});
