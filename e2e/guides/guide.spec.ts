import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  const csrf = await (await page.request.get('/api/auth/csrf')).json();
  await page.request.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: csrf.csrfToken,
      email: 'admin@example.test',
      password: 'local-inventory-password',
      callbackUrl: baseURL!,
      json: 'true',
    },
  });
});

test('guide is linked, illustrated and read-only, including print', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.goto('/admin/dashboard');
  await page.getByRole('link', { name: 'Getting started', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up enterprise SSO', level: 1 })).toBeVisible();
  const guide = page.locator('[data-sso-guide]');
  await expect(guide.locator('figure')).toHaveCount(6);
  for (const image of await guide.locator('img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
      .toBe(true);
  }
  for (const id of ['prepare', 'provider', 'membership', 'pilot', 'publish', 'maintain']) {
    await guide.locator(`a[href="#${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(guide.locator(`#${id}`)).toBeInViewport();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('guide-overview.png') });
  await page.screenshot({ path: testInfo.outputPath('guide.png'), fullPage: true });
  await page.evaluate(() => {
    window.print = () => document.body.setAttribute('data-print-requested', 'true');
  });
  await page.getByRole('button', { name: 'Print / save PDF', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-print-requested', 'true');
  await page.emulateMedia({ media: 'print' });
  for (const chrome of await page.locator('[data-admin-chrome]').all()) await expect(chrome).toBeHidden();
  await expect(page.locator('[data-admin-content]')).toHaveCSS('padding-left', '0px');
  await expect(page.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeHidden();
  await page.pdf({ path: testInfo.outputPath('enterprise-sso.pdf'), format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  await page.locator('nav').getByRole('link', { name: 'Guides', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Guides', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Set up enterprise SSO/ }).click();
  await expect(guide).toBeVisible();
  expect(writes).toEqual([]);
});

test('guide fits a narrow viewport and keeps normal admin sign-in', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/guides/enterprise-sso');
  await expect(page.getByRole('heading', { name: 'Set up enterprise SSO', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const anonymous = await browser.newContext({ baseURL });
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto('/admin/guides/enterprise-sso');
    await expect(visitor).toHaveURL(/\/admin\/auth\/login/);
  } finally {
    await anonymous.close();
  }
});
