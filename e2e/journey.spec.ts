// The core user journey from the brief, against the isolated e2e stack (see global-setup.ts).
import { expect, test } from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:4599/';
const PASSWORD = 'correct-horse-battery-staple';

test('register, audit a site, track AI visibility, draft content, report and manage the account', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = `e2e-${Date.now()}@example.test`;
  let projectPath = '';

  await test.step('register', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('E2E Tester');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('checkbox', { name: /I agree to the/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/app\/projects\/new/);
    await expect(page.getByRole('heading', { name: /Tell us about the business/ })).toBeVisible();
  });

  await test.step('create a project and start the first audit', async () => {
    await page.getByLabel('Business name').fill('E2E Fixture Outdoor');
    await page.getByRole('textbox', { name: 'Website' }).fill(FIXTURE);
    // The wizard: type and presence, location (not needed for this site), markets, then the plan.
    for (let step = 0; step < 4; step++) await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('With your website')).toBeVisible();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/app\/p\/[^/]+\/audits\/[^/]+$/);
    projectPath = new URL(page.url()).pathname.replace(/\/audits\/[^/]+$/, '');
  });

  await test.step('view the completed audit', async () => {
    await expect(page.getByText('Site health index').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('img', { name: /Site health index: \d+ out of 100/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Missing page title' }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Crawled pages' }).click();
    await expect(page.getByRole('link', { name: '/no-title' })).toBeVisible();
  });

  await test.step('compare keyword trends (labeled development fixture) and save a term', async () => {
    await page.goto(`${projectPath}/trends`);
    await page.getByLabel('Search terms').fill('hiking boots\ntrail shoes');
    await page.getByRole('button', { name: 'Fetch live data' }).click();
    await expect(page.getByText(/Your site and these searches/)).toBeVisible({ timeout: 60_000 });
    // The source is labeled on the report (and again in the Data sources panel).
    await expect(
      page
        .locator('span')
        .filter({ hasText: /^Development fixture \(not real Google data\)$/ })
        .first(),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select hiking boots', exact: true }).click();
    await page.getByRole('button', { name: /Save 1 to keywords/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved 1 keyword/)).toBeVisible();
  });

  await test.step('create an AI visibility prompt', async () => {
    await page.goto(`${projectPath}/visibility?tab=prompts`);
    await page.getByRole('button', { name: 'Add prompt' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Prompt').fill('Which outdoor gear shops do hikers recommend?');
    // Only the labeled demo provider is configured in the e2e stack; it is preselected.
    await expect(dialog.getByRole('checkbox', { name: /Demo fixtures/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /OpenAI · web search/ })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Add prompt' }).click();
    await expect(page.getByText('Which outdoor gear shops do hikers recommend?')).toBeVisible();
  });

  await test.step('run a development mock observation', async () => {
    await page.getByRole('button', { name: /Run now: Which outdoor gear shops/ }).click();
    await expect(page.getByText('AI visibility run')).toBeVisible();
    await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Observations' }).click();
    await page.locator('a[href*="/visibility/observations/"]').first().click();
    await expect(page.getByText('Demo data — not a real AI response').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Citations/ })).toBeVisible();
  });

  await test.step('generate a content draft', async () => {
    await page.goto(`${projectPath}/content`);
    await page.getByRole('button', { name: 'New brief' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Working title').fill('How to choose hiking boots');
    await dialog.getByLabel('Primary keyword').fill('hiking boots');
    await dialog.getByRole('button', { name: 'Create brief and draft' }).click();
    await expect(page).toHaveURL(/\/content\/[^/]+$/);
    await page.getByRole('button', { name: /Full draft/ }).click();
    await expect(page.getByText('Generating content')).toBeVisible();
    await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Body (Markdown)')).not.toHaveValue('', { timeout: 20_000 });
    await expect(page.getByText('Development template text')).toBeVisible();
  });

  await test.step('generate and view a report', async () => {
    await page.goto(`${projectPath}/reports`);
    await page.getByRole('button', { name: 'New report' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate report' }).click();
    await expect(page).toHaveURL(/\/reports\/[^/]+$/);
    const report = page.frameLocator('iframe');
    await expect(report.getByText('E2E Fixture Outdoor').first()).toBeVisible({ timeout: 60_000 });
  });

  await test.step('change account settings', async () => {
    await page.goto('/app/settings');
    await page.getByLabel('Name', { exact: true }).fill('E2E Tester Renamed');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile updated')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Tester Renamed');
  });

  await test.step('log out and log back in', async () => {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`${projectPath}/audits`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(new RegExp(`${projectPath}/audits$`));
  });
});
