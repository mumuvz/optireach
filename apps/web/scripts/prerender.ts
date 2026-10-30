// Build step: renders every public route to static HTML (dist/<route>/index.html), writes the SPA
// shell for the dashboard (dist/app.html, noindex), the 404 page, sitemap.xml and robots.txt.
// Run after `vite build` and `vite build --ssr src/entry-server.tsx --outDir dist-ssr`.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface ServerEntry {
  render(url: string): { html: string; head: string };
  publicRoutes(): {
    path: string;
    sitemap: boolean;
    priority?: number;
    changefreq?: string;
    lastmod?: string;
  }[];
  SITE_URL: string;
}

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const ssrEntry = path.join(root, 'dist-ssr', 'entry-server.js');

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fill(template: string, head: string, html: string): string {
  if (!template.includes('<!--app-head-->') || !template.includes('<!--app-html-->')) {
    throw new Error('dist/index.html is missing the <!--app-head--> or <!--app-html--> placeholder');
  }
  return template.replace('<!--app-head-->', head).replace('<!--app-html-->', html);
}

async function main(): Promise<void> {
  const template = await readFile(path.join(dist, 'index.html'), 'utf8');
  const entry = (await import(pathToFileURL(ssrEntry).href)) as ServerEntry;
  const routes = entry.publicRoutes();
  const site = entry.SITE_URL.replace(/\/$/, '');

  for (const route of routes) {
    const { html, head } = entry.render(route.path);
    if (!head) throw new Error(`Route ${route.path} rendered without <Seo> metadata`);
    const file =
      route.path === '/' ? path.join(dist, 'index.html') : path.join(dist, route.path.slice(1), 'index.html');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, fill(template, head, html));
  }

  // 404 page (served with status 404 by the static server).
  const notFound = entry.render('/__not-found__');
  await writeFile(path.join(dist, '404.html'), fill(template, notFound.head, notFound.html));

  // SPA shell for /app/* and token pages (verify email, invitations). Never indexed.
  await writeFile(
    path.join(dist, 'app.html'),
    fill(template, '<title>Surfaced</title>\n    <meta name="robots" content="noindex, nofollow">', ''),
  );

  const urls = routes
    .filter((r) => r.sitemap)
    .map((r) =>
      [
        '  <url>',
        `    <loc>${escapeXml(`${site}${r.path === '/' ? '/' : r.path}`)}</loc>`,
        r.lastmod ? `    <lastmod>${r.lastmod}</lastmod>` : null,
        r.changefreq ? `    <changefreq>${r.changefreq}</changefreq>` : null,
        r.priority !== undefined ? `    <priority>${r.priority.toFixed(1)}</priority>` : null,
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  await writeFile(
    path.join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
  );

  await writeFile(
    path.join(dist, 'robots.txt'),
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /app/',
      'Disallow: /api/',
      'Disallow: /invite/',
      'Disallow: /verify-email',
      '',
      `Sitemap: ${site}/sitemap.xml`,
      '',
    ].join('\n'),
  );

  // The SSR bundle is only needed for this step.
  await rm(path.join(root, 'dist-ssr'), { recursive: true, force: true });
  console.log(
    `[prerender] ${routes.length} routes, 404.html, app.html, sitemap.xml (${urls.length} URLs) and robots.txt written to dist/`,
  );
}

main().catch((error: unknown) => {
  console.error('[prerender] failed:', error);
  process.exitCode = 1;
});
