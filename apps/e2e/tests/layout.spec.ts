import { expect, test } from '@playwright/test';

// Re-audit FE-R-013: in the side-pane layout an empty pane reserved a blank column on the
// right (about half of a 667 px landscape phone), which could hide the only bottle. With
// nothing to show there, the map takes the whole width.
for (const [width, height] of [
  [667, 375],
  [1280, 800],
] as const) {
  test(`the map is not narrowed by an empty side pane at ${width}×${height}`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser is enough for a layout measurement');
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).last().click();
    const name = `e2e_l${width}_${Date.now().toString(36)}`;
    await page.getByLabel('Username').fill(name);
    await page.getByLabel('Email').fill(`${name}@example.test`);
    await page.getByLabel('Password', { exact: true }).fill('A-long-test-password-1');
    await page.getByLabel('Confirm password').fill('A-long-test-password-1');
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('button', { name: 'Create account' }).first().click();
    // Shore setup always has its list in the pane: the map leaves room for it there.
    await page.getByRole('searchbox').last().fill('Lisbon');
    await page
      .getByRole('radio', { name: /Lisbon/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Anchor here' }).locator('visible=true').first().click();
    await expect(page.getByRole('heading', { name: 'Ocean' })).toBeVisible();
    // Once the screen has settled (a loading sheet may show for a moment first).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
          return r('.world-layer').width / r('.world-screen').width;
        }),
      )
      .toBe(1);
    await page.close();
  });
}
