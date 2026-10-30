// A tiny local website used to test the crawler and audit rules end to end.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

export interface FixtureSite {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

const page = (title: string | null, body: string, head = '') => `<!doctype html>
<html lang="en"><head>${title !== null ? `<title>${title}</title>` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body>${body}</body></html>`;

/** Port allowlisted for API tests via CRAWLER_DEV_ALLOWLIST (see test/setup-env.ts). */
export const API_TEST_FIXTURE_PORT = 4599;

export async function startFixtureSite(
  options: { robotsStatus?: number; port?: number } = {},
): Promise<FixtureSite> {
  const requests: string[] = [];
  let origin = '';
  const routes: Record<
    string,
    (send: (status: number, body: string, headers?: Record<string, string>) => void) => void
  > = {
    '/robots.txt': (send) =>
      options.robotsStatus && options.robotsStatus !== 200
        ? send(options.robotsStatus, 'error')
        : send(200, `User-agent: *\nDisallow: /private/\n\nSitemap: ${origin}/sitemap.xml\n`, {
            'content-type': 'text/plain',
          }),
    '/sitemap.xml': (send) =>
      send(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
        { 'content-type': 'application/xml' },
      ),
    '/': (send) =>
      send(
        200,
        page(
          'Fixture Outdoor Gear | Home',
          `<h1>Outdoor gear for every trail</h1>
           <p>${'Durable boots and jackets for hikers. '.repeat(40)}</p>
           <a href="/about">About us</a> <a href="/products">Products</a> <a href="/broken">Old page</a>
           <a href="/redirect-old">Legacy link</a> <a href="/private/secret">Private</a>
           <a href="https://external.example.org/">Partner</a> <a href="mailto:hi@example.com">Mail</a>
           <a href="/products#reviews">click here</a>
           <img src="/hero.jpg"><img src="/logo.png" alt="Logo" width="10" height="10">
           <h2>How do I choose hiking boots?</h2><p>Answer.</p><h2>What size should I buy?</h2><p>Answer.</p>`,
          `<meta name="description" content="Durable outdoor gear for hikers, campers and trail runners, with free returns.">
           <link rel="canonical" href="${origin}/">
           <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture Outdoor","url":"${origin}/"}</script>`,
        ),
      ),
    '/about': (send) =>
      send(200, page('Same Title', '<h2>About</h2><p>We sell gear.</p><a href="/">Home</a>')),
    '/products': (send) =>
      send(
        200,
        page(
          'Same Title',
          '<h1>Products</h1><a href="/products/item-1">Item 1</a><a href="/no-title">Untitled</a><a href="/">Home</a>',
        ),
        {
          'content-encoding': 'gzip',
        },
      ),
    '/products/item-1': (send) =>
      send(
        200,
        page(
          'Item 1 | Fixture',
          '<h1>Item</h1><h1>Duplicate H1</h1><h4>Skipped</h4><a href="/">Home</a>',
          '<script type="application/ld+json">{"@type": "Product", oops}</script>',
        ),
      ),
    '/broken': (send) => send(404, page('Not found', '<h1>404</h1>')),
    '/no-title': (send) =>
      send(200, page(null, '<h1>A page without a title</h1><p>Some text.</p><a href="/">Home</a>')),
    '/redirect-old': (send) => send(301, '', { location: '/redirect-mid' }),
    '/redirect-mid': (send) => send(301, '', { location: '/about' }),
    '/to-metadata': (send) => send(302, '', { location: 'http://169.254.169.254/latest/meta-data/' }),
    '/orphan': (send) => send(200, page('Orphan page', '<h1>Only in the sitemap</h1><a href="/">Home</a>')),
    '/private/secret': (send) => send(200, page('Secret', '<h1>Should never be fetched</h1>')),
    '/big': (send) => send(200, page('Big', `<p>${'x'.repeat(300_000)}</p>`)),
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    requests.push(path);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      let payload: Buffer = Buffer.from(body);
      if (headers['content-encoding'] === 'gzip') payload = gzipSync(payload);
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(payload);
    };
    if (path === '/sitemap-pages.xml') {
      const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${['/', '/about', '/orphan', '/broken'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(gzipSync(Buffer.from(xml)));
      return;
    }
    if (path === '/slow') {
      setTimeout(() => send(200, page('Slow', '<h1>Slow</h1>')), 3000);
      return;
    }
    const handler = routes[path];
    if (handler) handler(send);
    else send(404, page('Not found', '<h1>404</h1>'));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
