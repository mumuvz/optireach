// Captures design-reference screenshots of the inspiration site into docs/reference/.
// Usage: node scripts/capture-reference.mjs
// These images are internal research material only; they are not shipped with the product.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('docs/reference');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const targets = [
  { name: 'homepage', url: 'https://aeoengine.ai/?ref=trustmrr', slices: 8 },
  { name: 'platform-features', url: 'https://aeoengine.ai/platform', slices: 6 },
  { name: 'pricing', url: 'https://aeoengine.ai/pricing', slices: 5 },
  { name: 'report-layout', url: 'https://aeoengine.ai/aeo-report-template', slices: 5 },
];

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // Trigger lazy-loaded sections by scrolling through the page once.
  await page.evaluate(async () => {
    const step = window.innerHeight / 2;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

async function outline(page) {
  return page.evaluate(() => {
    const pick = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 80);
    const style = getComputedStyle(document.body);
    return {
      title: document.title,
      h1: pick('h1'),
      h2: pick('h2'),
      h3: pick('h3'),
      navLinks: pick('header a, nav a').slice(0, 40),
      buttons: pick('button, a[class*="btn"], a[class*="button"]').slice(0, 40),
      sectionCount: document.querySelectorAll('section').length,
      bodyFont: style.fontFamily,
      bodyBackground: style.backgroundColor,
      bodyColor: style.color,
      pageHeight: document.body.scrollHeight,
    };
  });
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  try {
    for (const t of targets) {
      for (const device of ['desktop', 'mobile']) {
        const context = await browser.newContext(
          device === 'desktop'
            ? { viewport: { width: 1440, height: 900 }, userAgent: UA, deviceScaleFactor: 1 }
            : {
                viewport: { width: 390, height: 844 },
                userAgent:
                  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                deviceScaleFactor: 2,
                isMobile: true,
                hasTouch: true,
              },
        );
        const page = await context.newPage();
        const entry = { target: t.name, device, url: t.url, files: [] };
        try {
          const resp = await page.goto(t.url, { timeout: 45000, waitUntil: 'domcontentloaded' });
          entry.status = resp?.status() ?? null;
          await settle(page);
          const base = `${t.name}-${device}`;
          await page.screenshot({ path: path.join(OUT, `${base}.png`), fullPage: true });
          entry.files.push(`${base}.png`);
          if (device === 'desktop') {
            const height = await page.evaluate(() => document.body.scrollHeight);
            const sliceCount = Math.min(t.slices, Math.ceil(height / 900));
            for (let i = 0; i < sliceCount; i++) {
              await page.evaluate((y) => window.scrollTo(0, y), i * 900);
              await page.waitForTimeout(400);
              const file = `${t.name}-desktop-section-${String(i + 1).padStart(2, '0')}.png`;
              await page.screenshot({ path: path.join(OUT, file) });
              entry.files.push(file);
            }
            entry.outline = await outline(page);
          } else if (t.name === 'homepage') {
            await page.evaluate(() => window.scrollTo(0, 0));
            const toggle = page
              .locator('button[aria-label*="menu" i], button[aria-controls*="menu" i], header button')
              .first();
            if (await toggle.count()) {
              await toggle.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(700);
              await page.screenshot({ path: path.join(OUT, 'homepage-mobile-nav.png') });
              entry.files.push('homepage-mobile-nav.png');
            }
          }
        } catch (err) {
          entry.error = String(err?.message || err).slice(0, 500);
        }
        report.push(entry);
        console.log(
          `${t.name} [${device}] status=${entry.status ?? '-'} files=${entry.files.length}${entry.error ? ' error=' + entry.error : ''}`,
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(OUT, 'capture-log.json'),
    JSON.stringify({ capturedAt: new Date().toISOString(), report }, null, 2),
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
