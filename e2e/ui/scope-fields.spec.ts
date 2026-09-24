import { randomUUID } from 'crypto';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
  );
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

test('Product menu shows the prefilled value and supports selection, keyboard, filtering and custom keys', async ({
  page,
}) => {
  let products = ['Example product'];
  await page.route('**/api/admin/connections/defaults', (route) =>
    route.fulfill({ json: { product: products[0], products, complete: true } })
  );
  for (const url of ['/admin/sso-connection/new', '/admin/sso-connection/setup-link/new']) {
    await page.goto(url);
    const input = page.getByRole('combobox', { name: 'Product', exact: true });
    await expect(input).toHaveValue('Example product');
    await page.getByRole('button', { name: 'Choose a known Product', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Example product', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Example product', exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await input.fill('New Product KEY');
    await expect(page.getByText('No matching Products. You can enter a new value.')).toBeVisible();
    await input.press('Escape');
    await expect(input).toHaveValue('New Product KEY');
    await expect(page.getByRole('listbox')).toHaveCount(0);
  }
  products = ['Example product', 'Second product'];
  await page.goto('/admin/sso-connection/new');
  const input = page.getByRole('combobox', { name: 'Product', exact: true });
  await input.press('ArrowUp');
  await input.press('Enter');
  await expect(input).toHaveValue('Second product');
  await input.fill('EXAMPLE');
  await expect(page.getByRole('option')).toHaveCount(1);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('Example product');
  await page.getByRole('button', { name: 'Choose a known Product', exact: true }).click();
  await page.getByRole('option', { name: 'Second product', exact: true }).click();
  await expect(input).toHaveValue('Second product');
  await input.fill('Unlisted case-sensitive product');
  await input.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(input).toHaveValue('Unlisted case-sensitive product');
});

test('scope help is generic and distinguishes customer, application and allowed tenants; radios stay circular', async ({
  page,
}) => {
  await page.goto('/admin/sso-connection/new');
  const aboutTenant = page.getByRole('button', { name: /^About Tenant:/ });
  await expect(aboutTenant).toHaveAttribute('aria-label', /stable customer key/);
  await aboutTenant.focus();
  await expect
    .poll(() => aboutTenant.evaluate((node) => getComputedStyle(node.parentElement!, '::before').opacity))
    .toBe('1');
  await expect(page.getByRole('button', { name: /^About Product:/ })).toHaveAttribute(
    'aria-label',
    /including capitalization/
  );
  for (const name of ['SAML', 'OIDC']) {
    const radio = page.getByRole('radio', { name, exact: true });
    await radio.check();
    const geometry = await radio.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        radius: parseFloat(style.borderRadius),
      };
    });
    expect(geometry.width).toBe(24);
    expect(geometry.height).toBe(24);
    expect(geometry.radius).toBeGreaterThanOrEqual(12);
    await expect(radio).toBeChecked();
  }
  await page.goto('/admin/identity-federation/new');
  await expect(aboutTenant).toHaveAttribute('aria-label', /application's own stable tenant key/);
  await expect(page.getByRole('button', { name: /^About Tenants:/ })).toHaveAttribute(
    'aria-label',
    /all of its matching-Product connections/
  );
  const descriptions = await page
    .locator('button[aria-label^="About "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')).join(' '));
  expect(descriptions).not.toContain('Example product');
});

test('federation edit retains immutable keys while exposing contextual help', async ({ page, baseURL }) => {
  const tenant = `scope-app-${randomUUID()}`;
  const created = await page.request.post('/api/admin/identity-federation', {
    data: {
      name: 'Example application',
      type: 'saml',
      tenant,
      product: 'Example product',
      acsUrl: `${baseURL}/callback`,
      entityId: `${baseURL}/entity/${tenant}`,
    },
  });
  expect(created.status()).toBe(201);
  const { data: app } = await created.json();
  await page.goto(`/admin/identity-federation/${app.id}/edit`);
  await expect(page.getByLabel('Tenant', { exact: true })).toHaveValue(tenant);
  await expect(page.getByLabel('Tenant', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Example product');
  await expect(page.getByRole('button', { name: /^About Product:/ })).toHaveAttribute(
    'aria-label',
    /exactly the same Product/
  );
  await expect(page.locator('form').filter({ hasText: 'NameTenantProductEntity ID /' })).toHaveCount(1);
});

test('directory scope fields retain provider metadata and persist exact keys; setup forms have matching help', async ({
  page,
  baseURL,
}) => {
  const tenant = `scope-directory-${randomUUID()}`;
  await page.goto('/admin/directory-sync/new');
  await page.getByLabel('Directory name', { exact: true }).fill('Example directory');
  await page.getByLabel('Directory provider', { exact: true }).selectOption('generic-scim-v2');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant);
  await page.getByLabel('Product', { exact: true }).fill('Example Directory Product');
  await expect(page.getByLabel('Directory name', { exact: true })).toHaveValue('Example directory');
  await expect(page.getByRole('button', { name: /^About Product:/ })).toHaveAttribute(
    'aria-label',
    /directory events/
  );
  await page.getByLabel('Webhook URL', { exact: true }).fill(`${baseURL}/api/hello`);
  await page.getByLabel('Webhook secret', { exact: true }).fill('local-fixture');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/directory-sync') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create Directory', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(201);
  const { data: directory } = await response.json();
  expect(directory.tenant).toBe(tenant);
  expect(directory.product).toBe('Example Directory Product');
  await expect(page.getByRole('button', { name: /^About Tenant:/ })).toHaveAttribute(
    'aria-label',
    /Directory events carry this key/
  );
  await page.goto('/admin/directory-sync/setup-link/new');
  await expect(page.getByRole('button', { name: /^About Product:/ })).toHaveAttribute(
    'aria-label',
    /directory events/
  );
  await page.getByLabel('Tenant', { exact: true }).fill(`${tenant}-setup`);
  await page.getByLabel('Product', { exact: true }).fill('Example Directory Product');
  await expect(page.getByLabel('Tenant', { exact: true })).toHaveValue(`${tenant}-setup`);
});
