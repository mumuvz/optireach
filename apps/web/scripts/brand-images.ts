// Renders the static brand images in public/ (Open Graph card and a 512px logo) from HTML with
// Chromium. Run manually after changing the brand: `npx tsx apps/web/scripts/brand-images.ts`.
// The generated PNGs are committed; the build does not depend on Chromium.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const pub = path.join(root, 'public');

async function main(): Promise<void> {
  const mark = await readFile(path.join(pub, 'favicon.svg'), 'utf8');
  const markData = `data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`;
  const browser = await chromium.launch({
    executablePath: process.env.PDF_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      * { margin: 0; box-sizing: border-box; }
      body { width: 1200px; height: 630px; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #e8ecf5;
        background: radial-gradient(70% 90% at 50% 0%, rgba(99,102,241,.35), transparent 70%), #070b18; display: flex; flex-direction: column; justify-content: center; padding: 0 96px; }
      .brand { display: flex; align-items: center; gap: 20px; font-size: 44px; font-weight: 700; letter-spacing: -0.02em; }
      .brand img { width: 72px; height: 72px; }
      h1 { margin-top: 48px; font-size: 64px; line-height: 1.08; font-weight: 700; letter-spacing: -0.03em; max-width: 960px; }
      h1 span { background: linear-gradient(90deg, #a5b4fc, #7dd3fc); -webkit-background-clip: text; color: transparent; }
      p { margin-top: 28px; font-size: 28px; color: #9aa6bd; }
    </style></head><body>
      <div class="brand"><img src="${markData}" alt=""> Surfaced</div>
      <h1>Be found in search results <span>and in AI answers</span></h1>
      <p>SEO audits · Answer engine optimization · AI visibility tracking</p>
    </body></html>`);
    await writeFile(path.join(pub, 'og-image.png'), await page.screenshot({ type: 'png' }));

    const logo = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await logo.setContent(`<!doctype html><html><head><style>* { margin: 0 } body { width: 512px; height: 512px; background: transparent; }
      img { width: 512px; height: 512px; display: block; }</style></head><body><img src="${markData}" alt=""></body></html>`);
    await writeFile(
      path.join(pub, 'logo-512.png'),
      await logo.screenshot({ type: 'png', omitBackground: true }),
    );
    console.log('[brand-images] wrote public/og-image.png and public/logo-512.png');
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error('[brand-images] failed:', error);
  process.exitCode = 1;
});
