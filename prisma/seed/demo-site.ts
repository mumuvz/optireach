// In-memory demo website for the development seed. DemoSiteFetcher (a SafeFetcher subclass) serves
// it, so the real crawler and audit engine analyze it without any network access. The host uses the
// reserved .example TLD (RFC 2606), so it can never refer to a real site. The pages contain a few
// deliberate problems (missing descriptions, a duplicate title, thin content, an orphan page, a
// broken link, a slow page) so the demo audit has findings to show.
import {
  SafeFetcher,
  assertUrlPolicy,
  type FetchOptions,
  type FetchResult,
  type RedirectHop,
} from '@surfaced/core/crawler';

export const DEMO_HOST = 'northwind-outfitters.example';
export const DEMO_ORIGIN = `https://${DEMO_HOST}`;
export const DEMO_BRAND = 'Northwind Outfitters';
export const DEMO_COMPETITORS = [
  { name: 'Trailhead Supply', domain: 'trailhead-supply.example', aliases: ['Trailhead'] },
  { name: 'Summit Gear Co', domain: 'summitgear.example', aliases: ['Summit Gear'] },
];

interface DemoResponse {
  status: number;
  timeMs: number;
  body?: string;
  location?: string;
  contentType?: string;
}

const nav = `<header><nav aria-label="Main">
  <a href="/">Home</a> <a href="/tents">Tents</a> <a href="/backpacks">Backpacks</a> <a href="/jackets">Jackets</a>
  <a href="/guides/how-to-choose-a-tent">Tent buying guide</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/cart">Cart</a>
</nav></header>`;
const footer = `<footer><p>&copy; 2026 ${DEMO_BRAND} (demo site). <a href="https://social.example.com/northwind">Community</a></p></footer>`;

function html(opts: {
  title: string;
  description?: string;
  canonical?: string | false;
  robots?: string;
  head?: string;
  og?: boolean;
  body: string;
}): string {
  const canonical =
    opts.canonical === false ? '' : `<link rel="canonical" href="${DEMO_ORIGIN}${opts.canonical ?? ''}">`;
  const og =
    opts.og === false
      ? ''
      : `<meta property="og:title" content="${opts.title}">
<meta property="og:description" content="${opts.description ?? DEMO_BRAND}">
<meta property="og:image" content="${DEMO_ORIGIN}/img/og-default.jpg">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
${opts.description ? `<meta name="description" content="${opts.description}">` : ''}
${opts.robots ? `<meta name="robots" content="${opts.robots}">` : ''}
${canonical}
${og}
${opts.head ?? ''}
</head>
<body>
${nav}
<main>
${opts.body}
</main>
${footer}
</body>
</html>`;
}

const lorem = (topic: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>${topic} ${['are judged on weight, weather protection and how quickly they pack down.', 'should match the season, the terrain and how many nights you plan to spend outside.', 'last longer when they are dried before storage and cleaned with mild soap.', 'are easier to compare when you list the conditions you expect, not the conditions you hope for.'][i % 4]} Our staff test every model on day hikes and overnight trips before it reaches the shelves, and we publish what we learn so you can choose with confidence.</p>`,
  ).join('\n');

const PAGES: Record<string, () => DemoResponse> = {
  '/robots.txt': () => ({
    status: 200,
    timeMs: 40,
    contentType: 'text/plain; charset=utf-8',
    body: `User-agent: *\nDisallow: /cart\n\nSitemap: ${DEMO_ORIGIN}/sitemap.xml\n`,
  }),
  '/sitemap.xml': () => ({
    status: 200,
    timeMs: 60,
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
  '/',
  '/tents',
  '/backpacks',
  '/jackets',
  '/products/alpine-2-tent',
  '/products/trail-30-backpack',
  '/products/ridge-shell-jacket',
  '/guides/how-to-choose-a-tent',
  '/guides/winter-layering',
  '/about',
  '/contact',
]
  .map((p) => `  <url><loc>${DEMO_ORIGIN}${p}</loc></url>`)
  .join('\n')}
</urlset>`,
  }),
  '/': () => ({
    status: 200,
    timeMs: 210,
    body: html({
      title: `${DEMO_BRAND} — Tents, Backpacks and Outdoor Jackets`,
      description:
        'Field-tested tents, backpacks and waterproof jackets, with honest buying guides from our staff.',
      canonical: '/',
      head: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: DEMO_BRAND, url: `${DEMO_ORIGIN}/` })}</script>`,
      body: `<p class="promo"><a href="/old-sale">End-of-season sale: up to 30% off</a></p>
<h1>Outdoor gear tested on real trails</h1>
${lorem('Tents and backpacks', 5)}
<h2>Shop by category</h2>
<ul><li><a href="/tents">Tents</a></li><li><a href="/backpacks">Backpacks</a></li><li><a href="/jackets">Jackets</a></li></ul>
<h2>Popular right now</h2>
<ul><li><a href="/products/alpine-2-tent">Alpine 2 tent</a></li><li><a href="/products/trail-30-backpack">Trail 30 backpack</a></li><li><a href="/discontinued">Last season's sleeping bags</a></li></ul>
<img src="/img/hero.jpg" alt="Two tents pitched beside a lake at dusk" width="1200" height="600">`,
    }),
  }),
  '/tents': () => ({
    status: 200,
    timeMs: 260,
    body: html({
      title: `Tents | ${DEMO_BRAND}`,
      description: 'Backpacking and family tents for three-season and winter camping.',
      canonical: '/tents',
      body: `<h1>Tents</h1>${lorem('Tents', 5)}<p><a href="/products/alpine-2-tent">Alpine 2 tent</a> · <a href="/guides/how-to-choose-a-tent">How to choose a tent</a></p>`,
    }),
  }),
  '/backpacks': () => ({
    status: 200,
    timeMs: 240,
    body: html({
      title: `Backpacks | ${DEMO_BRAND}`,
      canonical: '/backpacks',
      body: `<h1>Backpacks</h1>${lorem('Backpacks', 5)}<p><a href="/products/trail-30-backpack">Trail 30 backpack</a></p>`,
    }),
  }),
  '/jackets': () => ({
    status: 200,
    timeMs: 250,
    body: html({
      // Deliberate copy-paste mistake: same title as /backpacks.
      title: `Backpacks | ${DEMO_BRAND}`,
      description: 'Waterproof shells and insulated jackets for hiking and travel.',
      canonical: '/jackets',
      body: `<h1>Jackets</h1>${lorem('Jackets', 5)}<p><a href="/products/ridge-shell-jacket">Ridge shell jacket</a></p>`,
    }),
  }),
  '/products/alpine-2-tent': () => ({
    status: 200,
    timeMs: 320,
    body: html({
      title: `Alpine 2 Two-Person Tent | ${DEMO_BRAND}`,
      description: 'A 1.6 kg two-person tent with two doors and a full-coverage fly.',
      canonical: '/products/alpine-2-tent',
      head: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Alpine 2 Tent', brand: { '@type': 'Brand', name: DEMO_BRAND } })}</script>`,
      body: `<h1>Alpine 2 Tent</h1>${lorem('Two-person tents', 5)}
<img src="/img/alpine-2.jpg" width="800" height="600">
<img src="/img/alpine-2-vestibule.jpg" alt="Alpine 2 vestibule with boots stored inside" width="800" height="600">
<p><a href="/tents">All tents</a> · <a href="/guides/how-to-choose-a-tent">Tent buying guide</a></p>`,
    }),
  }),
  '/products/trail-30-backpack': () => ({
    status: 200,
    timeMs: 280,
    body: html({
      title: `Trail 30 Backpack | ${DEMO_BRAND}`,
      description: 'A 30-litre daypack with a ventilated back panel.',
      canonical: '/products/trail-30-backpack',
      og: false,
      // Deliberately thin product copy and no Open Graph tags.
      body: `<h1>Trail 30 Backpack</h1><p>A 30-litre daypack. Available in two colours.</p><p><a href="/backpacks">All backpacks</a></p>`,
    }),
  }),
  '/products/ridge-shell-jacket': () => ({
    status: 200,
    // Deliberately slow page.
    timeMs: 2600,
    body: html({
      // Deliberately longer than 60 characters.
      title: `Ridge Shell Jacket — Waterproof Hiking Jacket | ${DEMO_BRAND}`,
      description: 'A three-layer waterproof shell with pit zips and a helmet-compatible hood.',
      canonical: '/products/ridge-shell-jacket',
      body: `<h1>Ridge Shell Jacket</h1>${lorem('Waterproof jackets', 5)}<p><a href="/jackets">All jackets</a></p>`,
    }),
  }),
  '/guides/how-to-choose-a-tent': () => ({
    status: 200,
    timeMs: 300,
    body: html({
      title: `How to Choose a Backpacking Tent | ${DEMO_BRAND}`,
      description: 'Capacity, weight, seasons and pitching: what matters when choosing a backpacking tent.',
      canonical: '/guides/how-to-choose-a-tent',
      head: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'How to choose a backpacking tent', author: { '@type': 'Organization', name: DEMO_BRAND } })}</script>`,
      body: `<article><h1>How to choose a backpacking tent</h1>
<h2>Capacity</h2>${lorem('Tents', 2)}
<h2>Weight and packed size</h2>${lorem('Lightweight tents', 2)}
<h2>Seasons</h2>${lorem('Three-season tents', 2)}
<h2>Frequently asked questions</h2>
<h3>Is a two-person tent big enough for two people?</h3><p>For two adults with small packs, yes; choose a three-person tent if you want room for gear inside.</p>
<h3>Do I need a footprint?</h3><p>A footprint protects the floor on rough ground and is worth it for tents you plan to keep for years.</p>
<p><a href="/tents">Shop tents</a> · <a href="/products/alpine-2-tent">Alpine 2 tent</a></p></article>`,
    }),
  }),
  // Orphan page: listed in the sitemap but not linked from any page.
  '/guides/winter-layering': () => ({
    status: 200,
    timeMs: 290,
    body: html({
      title: `Winter Layering Guide | ${DEMO_BRAND}`,
      description: 'Base, mid and outer layers explained for cold-weather hiking.',
      canonical: '/guides/winter-layering',
      body: `<article><h1>Winter layering, explained</h1>${lorem('Base layers', 5)}<p><a href="/jackets">Shop jackets</a></p></article>`,
    }),
  }),
  '/about': () => ({
    status: 200,
    timeMs: 230,
    body: html({
      title: `About Us | ${DEMO_BRAND}`,
      description: 'An independent outdoor retailer founded by hikers.',
      canonical: '/about',
      // Deliberately missing an h1.
      body: `<h2>Our story</h2>${lorem('Our recommendations', 5)}`,
    }),
  }),
  '/contact': () => ({
    status: 200,
    timeMs: 220,
    body: html({
      title: `Contact | ${DEMO_BRAND}`,
      description: 'Questions about an order or a product? Get in touch.',
      robots: 'noindex',
      canonical: '/contact',
      body: `<h1>Contact us</h1><p>Email the team and we will reply within one working day.</p>`,
    }),
  }),
  '/old-sale': () => ({ status: 301, timeMs: 50, location: '/sale' }),
  '/sale': () => ({
    status: 200,
    timeMs: 240,
    body: html({
      title: `Sale | ${DEMO_BRAND}`,
      description: 'Discounted tents, packs and jackets from last season.',
      canonical: '/sale',
      body: `<h1>Sale</h1>${lorem('Discounted tents', 5)}`,
    }),
  }),
};

function respond(url: URL): DemoResponse {
  if (url.hostname !== DEMO_HOST)
    return { status: 404, timeMs: 30, contentType: 'text/plain', body: 'Not found' };
  if (url.protocol === 'http:')
    return { status: 301, timeMs: 30, location: `${DEMO_ORIGIN}${url.pathname}${url.search}` };
  const handler = PAGES[url.pathname];
  if (handler) return handler();
  return {
    status: 404,
    timeMs: 120,
    body: html({
      title: `Page not found | ${DEMO_BRAND}`,
      canonical: false,
      body: '<h1>Page not found</h1><p>The page you are looking for does not exist.</p>',
    }),
  };
}

/** Serves the demo site from memory. Redirects, robots checks and the URL policy follow SafeFetcher. */
export class DemoSiteFetcher extends SafeFetcher {
  override async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const redirectChain: RedirectHop[] = [];
    let current = url;
    let elapsed = 0;
    const failure = (code: NonNullable<FetchResult['error']>['code'], message: string): FetchResult => ({
      requestedUrl: url,
      redirectChain,
      finalUrl: current,
      statusCode: null,
      headers: {},
      contentType: null,
      contentEncoding: null,
      body: null,
      bodyTruncated: false,
      responseTimeMs: null,
      totalTimeMs: elapsed,
      error: { code, message },
    });
    for (let hop = 0; hop <= 5; hop += 1) {
      const target = new URL(current);
      try {
        assertUrlPolicy(target);
      } catch (error) {
        return failure('BLOCKED', (error as Error).message);
      }
      if (options.beforeRequest && !(await options.beforeRequest(target)))
        return failure('DISALLOWED', 'Blocked by robots.txt');
      const response = respond(target);
      elapsed += response.timeMs;
      if (response.location) {
        redirectChain.push({ url: current, statusCode: response.status });
        current = new URL(response.location, target).toString();
        continue;
      }
      const contentType = response.contentType ?? 'text/html; charset=utf-8';
      const headers: Record<string, string> = {
        'content-type': contentType,
        'content-encoding': 'br',
        'cache-control': 'public, max-age=300',
        'strict-transport-security': 'max-age=31536000',
      };
      const wantsBody = options.readBody !== false && options.method !== 'HEAD';
      return {
        requestedUrl: url,
        redirectChain,
        finalUrl: current,
        statusCode: response.status,
        headers,
        contentType,
        contentEncoding: 'br',
        body: wantsBody && response.body !== undefined ? Buffer.from(response.body, 'utf8') : null,
        bodyTruncated: false,
        responseTimeMs: response.timeMs,
        totalTimeMs: elapsed,
        error: null,
      };
    }
    return failure('TOO_MANY_REDIRECTS', 'More than 5 redirects');
  }
}
