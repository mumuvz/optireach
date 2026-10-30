// Public site: prerendered HTML, crawl files, the free audit and the pricing page.
import { expect, test } from '@playwright/test';

test('marketing pages are prerendered with metadata, and robots.txt and the sitemap are served', async ({
  request,
}) => {
  const home = await request.get('/');
  expect(home.status()).toBe(200);
  const html = await home.text();
  // Content and metadata are present in the HTML itself, before any JavaScript runs.
  expect(html).toContain('Be found in search results');
  expect(html).toMatch(/<link rel="canonical" href="[^"]+\/" data-seo>/);
  expect(html).toContain('"@type":"FAQPage"');

  expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap:');
  expect(await (await request.get('/sitemap.xml')).text()).toContain('/pricing</loc>');
  const missing = await request.get('/this-page-does-not-exist');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('noindex');
});

test('free audit of a website without an account', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/free-audit');
  await page.getByLabel('Website address').fill('not a url');
  await page.getByRole('button', { name: /Run a free audit/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Website address').fill('http://127.0.0.1:4599/');
  await page.getByRole('button', { name: /Run a free audit/ }).click();
  await expect(page).toHaveURL(/\/free-audit#id=[^&]+&token=/);
  await expect(page.getByText('Results for')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('img', { name: /Site health index: \d+ out of 100/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top issues' })).toBeVisible();
});

test('pricing page lists the configured plans and both intervals', async ({ page }) => {
  await page.goto('/pricing');
  for (const plan of ['Free', 'Starter', 'Growth', 'Agency'])
    await expect(page.getByRole('heading', { name: plan, exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Yearly' }).first().click();
  await expect(page.getByText(/billed yearly/).first()).toBeVisible();
  await expect(page.getByRole('table', { name: /Plan comparison/ })).toBeVisible();
});
