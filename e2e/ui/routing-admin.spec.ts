import { randomUUID } from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

const product = 'routing-browser';
async function connection(request: APIRequestContext, origin: string, tenant: string, name: string) {
  const issuer = `https://idp.example.test/fixture/${randomUUID()}`;
  const response = await request.post('/api/admin/connections', {
    data: {
      tenant,
      product,
      name,
      defaultRedirectUrl: `${origin}/callback`,
      redirectUrl: [origin],
      oidcClientId: randomUUID(),
      oidcClientSecret: 'local-upstream-fixture',
      oidcMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).data;
}

async function setup(request: APIRequestContext, origin: string) {
  const domain = `${randomUUID()}.example.test`;
  const old = await connection(request, origin, domain, 'Previous connection');
  const replacement = await connection(
    request,
    origin,
    `replacement-${randomUUID()}`,
    'Replacement connection'
  );
  const inventory = await request.get(`/api/admin/identity-federation?inventory=true&product=${product}`);
  expect(inventory.ok(), await inventory.text()).toBe(true);
  const existing = (await inventory.json()).data.find((app) => app.tenant === product);
  const response = existing
    ? await request.patch(`/api/admin/identity-federation/${existing.id}`, {
        data: { id: existing.id, tenants: [...existing.tenants, old.tenant, replacement.tenant] },
      })
    : await request.post('/api/admin/identity-federation', {
        data: {
          type: 'oidc',
          name: 'Routing browser application',
          tenant: product,
          product,
          tenants: [old.tenant, replacement.tenant],
          redirectUrl: [`${origin}/callback`],
        },
      });
  expect(response.status(), await response.text()).toBe(existing ? 200 : 201);
  const app = (await response.json()).data;
  const endpoint = (id: string) => `/api/admin/connections/${id}/routing?app=${app.id}`;
  const read = async (id: string) => (await request.get(endpoint(id))).json();
  const action = async (id: string, body: object) => {
    const result = await request.post(endpoint(id), { data: body });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
  const state = await read(old.clientID);
  if (state.managed)
    await action(old.clientID, {
      action: 'managed',
      enabled: false,
      expectedRevision: state.managed.revision,
    });
  return { domain, old, replacement, app, endpoint, read, action };
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
  );
  const csrf = await page.request.get('/api/auth/csrf');
  const response = await page.request.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: (await csrf.json()).csrfToken,
      email: 'admin@example.test',
      password: 'local-inventory-password',
      callbackUrl: baseURL!,
      json: 'true',
    },
  });
  expect(response.ok()).toBe(true);
});

test('draft, pilot, known unavailable, explicit withdrawal and browser authorize use the same route', async ({
  page,
  request,
  baseURL,
}) => {
  const { domain, old, replacement, app, action } = await setup(page.request, baseURL!);
  const resolve = async (email: string) => request.post('/api/sso/resolve', { data: { email } });
  expect((await resolve(`person@${domain}`)).status()).toBe(503);
  const imported = await action(old.clientID, {
    action: 'import',
    matches: [{ match: domain, expectedRevision: null }],
  });
  expect(imported.results[0].route.connectionID).toBe(old.clientID);
  await action(old.clientID, { action: 'managed', enabled: true, expectedRevision: null });
  expect(
    (
      await page.request.patch(`/api/admin/identity-federation/${app.id}`, {
        data: { id: app.id, tenants: [old.tenant] },
      })
    ).ok()
  ).toBe(true);
  await page.goto(`/admin/sso-connection/edit/${replacement.clientID}`);
  const panel = page.getByRole('region', { name: 'Login routing' });
  await panel.getByLabel('Domains or exact email addresses').fill(`pilot@${domain}`);
  await expect(panel.getByRole('button', { name: 'Review and publish' })).toBeDisabled();
  await page
    .getByRole('region', { name: 'Applications', exact: true })
    .getByRole('checkbox', { name: /Routing browser application/ })
    .click();
  await expect(panel.getByRole('button', { name: 'Review and publish' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Save draft' }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved');
  expect(await (await resolve(`pilot@${domain}`)).json()).toEqual({ required: true, idp_hint: old.clientID });
  await panel.getByRole('button', { name: 'Review and publish' }).click();
  await panel.getByRole('button', { name: 'Require SSO for these matches' }).click();
  await expect(panel.getByRole('status')).toContainText(`Published pilot@${domain}.`);
  expect(await (await resolve(`pilot@${domain}`)).json()).toEqual({
    required: true,
    idp_hint: replacement.clientID,
  });
  expect(await (await resolve(`other@${domain}`)).json()).toEqual({ required: true, idp_hint: old.clientID });
  const authorize = await request.get(
    `/api/oauth/authorize?${new URLSearchParams({ client_id: app.clientID, redirect_uri: `${baseURL}/callback`, response_type: 'code', scope: 'openid', state: 'local-fixture', login_hint: `pilot@${domain}` })}`,
    { maxRedirects: 0 }
  );
  expect(authorize.status(), await authorize.text()).toBe(302);
  const target = new URL(authorize.headers().location);
  expect(target.pathname).toBe(new URL(replacement.oidcProvider.metadata.authorization_endpoint).pathname);
  expect(target.searchParams.get('login_hint')).toBe(`pilot@${domain}`);
  const paused = await page.request.patch('/api/admin/connections', {
    data: { ...replacement, isOIDC: true, deactivated: true },
  });
  expect(paused.ok(), await paused.text()).toBe(true);
  expect(await (await resolve(`pilot@${domain}`)).json()).toEqual({
    required: true,
    idp_hint: null,
    reason: 'deactivated',
  });
  await page.reload();
  await expect(panel.getByText(/This connection is disabled/)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText(`Withdrew pilot@${domain}.`);
  expect(await (await resolve(`pilot@${domain}`)).json()).toEqual({ required: true, idp_hint: old.clientID });
  expect(
    (
      await request.post('/api/sso/resolve', { data: { email: `person@${domain}`, app: 'attacker-app' } })
    ).status()
  ).toBe(400);
  expect(await (await resolve('person@unconfigured.test')).json()).toEqual({ required: false });
});

test('a subset move keeps the old connection active; moving the rest retires it', async ({
  page,
  baseURL,
}) => {
  const { domain, old, replacement, action } = await setup(page.request, baseURL!);
  const other = `alias-${domain}`;
  await action(old.clientID, { action: 'managed', enabled: true, expectedRevision: null });
  await action(old.clientID, {
    action: 'publish',
    matches: [domain, other].map((match) => ({ match, expectedRevision: null })),
  });
  await page.goto(`/admin/sso-connection/edit/${replacement.clientID}`);
  const panel = page.getByRole('region', { name: 'Login routing' });
  for (const matches of [domain, `${domain}\n${other}`]) {
    await panel.getByLabel('Domains or exact email addresses').fill(matches);
    await panel.getByRole('button', { name: 'Review and publish' }).click();
    const dialog = panel.getByRole('dialog', { name: 'Confirm login routing' });
    await expect(dialog.getByText(/moves from Previous connection/)).toBeVisible();
    await expect(dialog.getByText(/does not rename tenants, merge accounts/)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('routing-confirmation.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Require SSO for these matches' }).click();
    await expect(panel.getByRole('status')).toContainText(`Published ${domain}.`);
    const [current] = await (await page.request.get(`/api/admin/connections/${old.clientID}`)).json();
    if (matches === domain) {
      await expect(panel.getByRole('status')).toContainText(`remains active for: ${other}`);
      expect(current.deactivated).toBe(false);
    } else {
      await expect(panel.getByRole('status')).toContainText('Disabled Previous connection.');
      expect(current.deactivated).toBe(true);
    }
  }
});

test('stale confirmation reports partial results and cannot disable a restored owner', async ({
  page,
  baseURL,
}) => {
  const { domain, old, replacement, action, read } = await setup(page.request, baseURL!);
  await action(old.clientID, { action: 'managed', enabled: true, expectedRevision: null });
  const initial = await action(old.clientID, {
    action: 'publish',
    matches: [{ match: domain, expectedRevision: null }],
  });
  await page.goto(`/admin/sso-connection/edit/${replacement.clientID}`);
  const panel = page.getByRole('region', { name: 'Login routing' });
  await panel.getByLabel('Domains or exact email addresses').fill(`${domain}\nnew-${domain}`);
  await panel.getByRole('button', { name: 'Review and publish' }).click();
  await expect(panel.getByRole('dialog')).toBeVisible();
  const newer = await action(old.clientID, {
    action: 'publish',
    matches: [{ match: domain, expectedRevision: initial.results[0].route.revision }],
  });
  await panel.getByRole('button', { name: 'Require SSO for these matches' }).click();
  await expect(panel.getByRole('status')).toContainText(`${domain} changed; reload before confirming.`);
  await expect(panel.getByRole('status')).toContainText(`Published new-${domain}.`);
  expect((await read(old.clientID)).routes).toEqual([newer.results[0].route]);
  const [current] = await (await page.request.get(`/api/admin/connections/${old.clientID}`)).json();
  expect(current.deactivated).toBe(false);
  const denied = await page.request.delete(
    `/api/admin/connections?${new URLSearchParams({ clientID: old.clientID, clientSecret: old.clientSecret })}`
  );
  expect(denied.status()).toBe(409);
});

test('confirmed restoration enables the destination before moving routes and retiring the old owner', async ({
  page,
  request,
  baseURL,
}) => {
  const { domain, old, replacement, action, read } = await setup(page.request, baseURL!);
  await action(old.clientID, { action: 'managed', enabled: true, expectedRevision: null });
  await action(replacement.clientID, {
    action: 'publish',
    matches: [{ match: domain, expectedRevision: null }],
  });
  expect(
    (
      await page.request.patch('/api/admin/connections', {
        data: { clientID: old.clientID, clientSecret: old.clientSecret, isOIDC: true, deactivated: true },
      })
    ).ok()
  ).toBe(true);
  await page.goto(`/admin/sso-connection/edit/${old.clientID}`);
  const panel = page.getByRole('region', { name: 'Login routing' });
  await panel.getByLabel('Domains or exact email addresses').fill(domain);
  await panel.getByRole('button', { name: 'Review and publish' }).click();
  const dialog = panel.getByRole('dialog');
  await expect(dialog.getByText(/Enable this connection before moving/)).toBeVisible();
  await expect(dialog.getByText(/existing routes, direct links and other application logins/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await read(old.clientID)).active).toBe(false);
  expect((await read(replacement.clientID)).routes).toHaveLength(1);
  await panel.getByRole('button', { name: 'Review and publish' }).click();
  await dialog.getByRole('button', { name: 'Enable this connection and publish' }).click();
  await expect(panel.getByRole('status')).toContainText('Enabled this connection.');
  await expect(panel.getByRole('status')).toContainText('Disabled Replacement connection.');
  await expect(panel.getByText(/This connection is disabled/)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Active', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Inactive', exact: true })).toHaveCount(0);
  expect((await read(old.clientID)).active).toBe(true);
  expect((await read(replacement.clientID)).active).toBe(false);
  expect(
    await (await request.post('/api/sso/resolve', { data: { email: `pilot@${domain}` } })).json()
  ).toEqual({ required: true, idp_hint: old.clientID });
});

test('normal connection creation defaults to the configured app product and permits overriding it', async ({
  page,
  baseURL,
}) => {
  await setup(page.request, baseURL!);
  const response = await page.request.get('/api/admin/connections/defaults?app=ignored');
  expect(await response.json()).toMatchObject({ product, complete: true });
  await page.goto('/admin/sso-connection/new');
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue(product);
  await page.getByLabel('Product', { exact: true }).fill('Another product');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Another product');
  await page.getByRole('radio', { name: 'OIDC', exact: true }).check();
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Another product');
  await page.getByLabel('Product', { exact: true }).fill('OIDC product override');
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('OIDC product override');
});

test('creation suggests known products and protocol-scoped redirects without losing entered metadata', async ({
  page,
  baseURL,
}) => {
  await page.route('**/api/admin/connections/defaults', (route) =>
    route.fulfill({
      json: {
        product: 'Acres',
        products: ['Acres', 'Future product'],
        complete: true,
        redirects: [
          {
            product: 'Acres',
            protocol: 'saml',
            suggestions: [`${baseURL}/saml`],
            defaults: { redirectUrl: [`${baseURL}/saml`], defaultRedirectUrl: `${baseURL}/saml` },
          },
          {
            product: 'Acres',
            protocol: 'oidc',
            suggestions: [`${baseURL}/oidc`],
            defaults: { redirectUrl: [`${baseURL}/oidc`], defaultRedirectUrl: `${baseURL}/oidc` },
          },
        ],
      },
    })
  );
  await page.goto('/admin/sso-connection/new');
  await expect(page.getByLabel('Allowed redirect URL 1', { exact: true })).toHaveValue(`${baseURL}/saml`);
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveValue(`${baseURL}/saml`);
  await page.getByRole('radio', { name: 'OIDC', exact: true }).check();
  await expect(page.getByLabel('Allowed redirect URL 1', { exact: true })).toHaveValue(`${baseURL}/oidc`);
  await page.getByLabel('Tenant', { exact: true }).fill('new-customer');
  await page.getByLabel('Connection name (Optional)', { exact: true }).fill('Unsaved connection name');
  await page.locator('#oidcClientSecret').fill('synthetic-unsaved-secret');
  await page.getByLabel('Product', { exact: true }).fill('');
  await expect(page.locator('#known-connection-products option')).toHaveCount(2);
  await page.getByLabel('Product', { exact: true }).fill('Custom product');
  await expect(page.getByLabel('Tenant', { exact: true })).toHaveValue('new-customer');
  await expect(page.getByLabel('Connection name (Optional)', { exact: true })).toHaveValue(
    'Unsaved connection name'
  );
  await expect(page.locator('#oidcClientSecret')).toHaveValue('synthetic-unsaved-secret');
  await page.getByLabel('Allowed redirect URL 1', { exact: true }).fill(`${baseURL}/custom`);
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveValue(`${baseURL}/custom`);
  await page.getByRole('button', { name: 'Add redirect URL', exact: true }).click();
  await page.getByLabel('Allowed redirect URL 2', { exact: true }).fill(`${baseURL}/second`);
  await expect(page.locator('#allowed-default-redirects option')).toHaveCount(2);
  await page.getByLabel('Default redirect URL', { exact: true }).fill(`${baseURL}/second`);
  await page.getByRole('button', { name: 'Remove redirect URL 2', exact: true }).click();
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveValue(`${baseURL}/custom`);
  await page.getByLabel('Allowed redirect URL 1', { exact: true }).fill('https://*.example.test/*');
  await expect(page.getByLabel('Default redirect URL', { exact: true })).toHaveValue(`${baseURL}/custom`);
  await expect(page.locator('#allowed-default-redirects option')).toHaveCount(0);
});

test('reactivation does not silently discard unsaved connection settings', async ({ page, baseURL }) => {
  const { old, action } = await setup(page.request, baseURL!);
  await action(old.clientID, { action: 'managed', enabled: true, expectedRevision: null });
  expect(
    (
      await page.request.patch('/api/admin/connections', {
        data: { clientID: old.clientID, clientSecret: old.clientSecret, isOIDC: true, deactivated: true },
      })
    ).ok()
  ).toBe(true);
  await page.goto(`/admin/sso-connection/edit/${old.clientID}`);
  await page.getByLabel('Connection name (Optional)', { exact: true }).fill('Unsaved edit');
  const panel = page.getByRole('region', { name: 'Login routing' });
  await panel.getByLabel('Domains or exact email addresses').fill('pilot@example.test');
  await expect(panel.getByRole('button', { name: 'Review and publish' })).toBeDisabled();
  await expect(panel.getByText(/Save your connection settings before enabling/)).toBeVisible();
  await expect(page.getByLabel('Connection name (Optional)', { exact: true })).toHaveValue('Unsaved edit');
});

test('missing or unavailable product defaults leave normal creation usable', async ({ page }) => {
  for (const status of [200, 503]) {
    await page.route('**/api/admin/connections/defaults', (route) =>
      route.fulfill({
        status,
        json: status === 200 ? {} : { error: { message: 'Fixture unavailable' } },
      })
    );
    await page.goto('/admin/sso-connection/new');
    await expect(page.getByLabel('Product', { exact: true })).toHaveValue('');
    await page.getByLabel('Product', { exact: true }).fill('Manual product');
    await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Manual product');
    if (status === 503) await expect(page.getByText(/Could not load the default product/)).toBeVisible();
    await page.unroute('**/api/admin/connections/defaults');
  }
});
