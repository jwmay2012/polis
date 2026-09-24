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
  await page.route('**/api/admin/connections/defaults', (route) =>
    route.fulfill({ json: { product: 'Acres', products: ['Acres', 'Another product'], complete: true } })
  );
});

test('setup defaults are federation-only and customer instructions use real protocol callbacks', async ({
  page,
  browser,
  baseURL,
}) => {
  const tenant = `setup-${randomUUID()}`;
  await page.goto('/admin/sso-connection/setup-link/new');
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Acres');
  await page.getByLabel('Product', { exact: true }).fill('');
  await expect(page.locator('#setup-known-products option')).toHaveCount(2);
  await page.getByLabel('Product', { exact: true }).fill('Acres');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant);
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveCount(0);
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/admin/setup-links') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create Setup Link', exact: true }).click();
  const { data: link } = await (await created).json();
  expect(JSON.parse(link.redirectUrl)).toEqual([]);
  expect(link.defaultRedirectUrl).toBe('http://_boxyhq_redirect_not_in_use');
  const token = new URL(link.url).pathname.split('/').pop();
  const customer = await browser.newContext({ baseURL });
  try {
    const setup = await customer.newPage();
    await setup.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
    );
    for (const provider of ['generic-saml', 'azure']) {
      await setup.goto(
        `/setup/${token}/sso-connection/new?idp=${provider}&step=${provider === 'azure' ? 2 : 1}`
      );
      await expect(
        setup.getByLabel('Reply URL (Assertion Consumer Service URL)', { exact: true })
      ).toHaveValue(`${baseURL}/api/oauth/saml`);
      await expect(setup.getByLabel('Identifier (Entity ID)', { exact: true })).toHaveValue(
        'https://sp.example.test/entity'
      );
      await expect(setup.getByText('http://_boxyhq_redirect_not_in_use', { exact: true })).toHaveCount(0);
    }
    await setup.goto(`/setup/${token}/sso-connection/new?idp=generic-oidc&step=1`);
    await expect(setup.getByLabel('Callback URL', { exact: true })).toHaveValue(`${baseURL}/api/oauth/oidc`);
    await setup.goto(`/setup/${token}/sso-connection/new?idp=generic-oidc&step=2`);
    await expect(setup.getByText(/Completing this setup saves/)).toBeVisible();
    await expect(setup.getByLabel('Product', { exact: true })).toHaveCount(0);
    await expect(setup.getByText('Advanced: Direct application integration', { exact: true })).toHaveCount(0);
    const response = await customer.request.post(`/api/setup/${token}/sso-connection`, {
      data: {
        tenant: 'attacker-tenant',
        product: 'attacker-product',
        redirectUrl: ['https://attacker.example.test'],
        defaultRedirectUrl: 'https://attacker.example.test',
        oidcClientId: randomUUID(),
        oidcClientSecret: 'local-fixture',
        oidcDiscoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const [summary] = await (await customer.request.get(`/api/setup/${token}/sso-connection`)).json();
    const [connection] = await (await page.request.get(`/api/admin/connections/${summary.clientID}`)).json();
    expect(connection.tenant).toBe(tenant);
    expect(connection.product).toBe('Acres');
    expect(connection.redirectUrl).toEqual([]);
    expect(connection.defaultRedirectUrl).toBe('http://_boxyhq_redirect_not_in_use');
  } finally {
    await customer.close();
  }
});

test('a reused link keeps its prior settings unless replacement is explicitly confirmed', async ({
  page,
  request,
  baseURL,
}) => {
  const tenant = `reuse-${randomUUID()}`;
  await page.goto('/admin/sso-connection/setup-link/new');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant);
  await page.getByText('Advanced: Direct application integration', { exact: true }).click();
  await page.getByLabel('Enable direct application integration', { exact: true }).check();
  await page.getByLabel('Allowed redirect URL 1', { exact: true }).fill(`${baseURL}/legacy`);
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveValue(`${baseURL}/legacy`);
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/admin/setup-links') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create Setup Link', exact: true }).click();
  const existing = await created;
  expect(existing.request().postDataJSON()).not.toHaveProperty('directIntegration');
  const { data: old } = await existing.json();
  await page.goto('/admin/sso-connection/setup-link/new');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant);
  await page.getByRole('button', { name: 'Create Setup Link', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: /existing link with different settings/ })
  ).toBeVisible();
  expect(
    (await (await request.get(`/api/setup/${new URL(old.url).pathname.split('/').pop()}`)).json()).data
      .redirectUrl
  ).toBe(JSON.stringify([`${baseURL}/legacy`]));
  await page
    .getByLabel('Replace an existing setup link for this tenant and product', { exact: true })
    .check();
  page.once('dialog', (dialog) => dialog.accept());
  const replaced = page.waitForResponse(
    (response) => response.url().endsWith('/api/admin/setup-links') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create Setup Link', exact: true }).click();
  const { data: current } = await (await replaced).json();
  expect(current.url).not.toBe(old.url);
  expect(JSON.parse(current.redirectUrl)).toEqual([]);
  const invalid = await request.get(`/api/setup/${new URL(old.url).pathname.split('/').pop()}`);
  expect(invalid.ok()).toBe(false);
});
