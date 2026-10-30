// HTML → PDF with headless Chromium (playwright-core). JavaScript is disabled and every network
// request is blocked, so report content can never trigger outbound requests (no SSRF via images).
import { chromium, type Browser } from 'playwright-core';
import { getEnv } from '../env';

export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

export async function renderPdf(html: string): Promise<Buffer> {
  const env = getEnv();
  if (env.PDF_RENDERER === 'none')
    throw new PdfUnavailableError('PDF rendering is disabled (PDF_RENDERER=none).');
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: env.PDF_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--disable-dev-shm-usage'],
    });
  } catch (error) {
    throw new PdfUnavailableError(
      `Chromium could not be started (${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}). Install it with "npx playwright install chromium" or set PDF_CHROMIUM_EXECUTABLE_PATH.`,
    );
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    await context.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
    await context.close();
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
