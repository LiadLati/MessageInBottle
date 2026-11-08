import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The production bundle, behind the reference proxy's headers and CSP, against the compiled
// API in production mode (serve.mjs). Re-audit QA-R-002 (no browser or accessibility suite)
// and the browser half of QA-R-003 (a failed lazy chunk must not blank the app).

const PASSWORD = 'A-long-test-password-1';

// Every console error, uncaught exception and CSP violation on the page. The GPU driver's
// performance warnings in a headless browser are warnings, not errors, and are not counted.
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return problems;
}

// Serious and critical accessibility violations only; each is reported with where it is.
async function expectAccessible(page: Page, where: string) {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(' ')}`);
  expect(serious, `${where}: ${serious.join('; ')}`).toEqual([]);
}

async function register(page: Page, info: TestInfo): Promise<string> {
  const name = `e2e_${info.project.name}_${Date.now().toString(36)}`.slice(0, 30);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByLabel('Username').fill(name);
  await page.getByLabel('Email').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('checkbox').nth(0).check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Create account' }).first().click();
  await expect(page.getByRole('heading', { name: 'Choose your shore' })).toBeVisible();
  return name;
}

async function chooseShore(page: Page) {
  const search = page.getByRole('searchbox', { name: 'Search shores' }).first();
  await ((await search.isVisible()) ? search : page.getByRole('searchbox').last()).fill('Lisbon');
  const result = page.getByRole('radio', { name: /Lisbon/ }).first();
  await result.click();
  await page.getByRole('button', { name: 'Anchor here' }).locator('visible=true').first().click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('signing up, choosing a shore and every main screen: no errors, no CSP violations, accessible', async ({
  page,
}, info) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expectAccessible(page, 'sign-in');

  await register(page, info);
  await expectAccessible(page, 'shore setup');
  await chooseShore(page);
  await expectAccessible(page, 'ocean');

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [tab, heading] of [
    ['Friends', 'Friends'],
    ['Letters', 'Letters'],
    ['Write', 'Who is this for?'],
    ['My Shore', null],
  ] as const) {
    await nav.getByRole('button', { name: tab, exact: true }).click();
    if (heading)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    else await page.waitForTimeout(500);
    await expectAccessible(page, tab);
  }
  expect(problems).toEqual([]);
});

test('a map chunk that fails to load is contained, and the app keeps working', async ({
  page,
}, info) => {
  // A deploy replaced the hashed files while the page was open: the map chunk is gone.
  await page.route(/\/assets\/maplibre-[^/]+\.js$/, (route) => route.abort());
  await register(page, info);
  await expect(page.getByRole('alert').filter({ hasText: 'could not be loaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // Searching still lists shores without the map, and the rest of the app still works.
  await chooseShore(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Friends', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Friends', exact: true })).toBeVisible();
});

test('the web app is served with the production security headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
  // An unknown path is the app, not a 404 (single-page routing), and API paths reach the API.
  expect((await request.get('/some/deep/link')).headers()['content-type']).toContain('text/html');
  expect((await (await request.get('/api/health')).json()) as { ok: boolean }).toMatchObject({
    ok: true,
  });
});
